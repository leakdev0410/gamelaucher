/* eslint-disable @typescript-eslint/no-explicit-any */
import axios, { AxiosError, AxiosInstance } from "axios";
import { WindowManager } from "./window-manager";
import { uploadGamesBatch } from "./library-sync";
import { clearGamesRemoteIds } from "./library-sync/clear-games-remote-id";
import { networkLogger as logger } from "./logger";
import {
  UserNotLoggedInError,
  SubscriptionRequiredError,
  appConfig,
} from "@shared";
import { omit } from "lodash-es";
import { appVersion } from "@main/constants";
import { getUserData } from "./user/get-user-data";
import { db } from "@main/level";
import { levelKeys } from "@main/level/sublevels";
import type { Auth, User } from "@types";
import { WSClient } from "./ws";

export interface ApiClientOptions {
  needsAuth?: boolean;
  needsSubscription?: boolean;
  ifModifiedSince?: Date;
}

interface ApiClientUserAuth {
  authToken: string;
  refreshToken: string;
  expirationTimestamp: number;
  subscription: { expiresAt: Date | string | null } | null;
}

export class ApiClient {
  private static instance: AxiosInstance;

  private static readonly EXPIRATION_OFFSET_IN_MS = 1000 * 60 * 5; // 5 minutes
  private static readonly ADD_LOG_INTERCEPTOR = true;

  private static secondsToMilliseconds(seconds: number) {
    return seconds * 1000;
  }

  private static userAuth: ApiClientUserAuth = {
    authToken: "",
    refreshToken: "",
    expirationTimestamp: 0,
    subscription: null,
  };

  public static isLoggedIn() {
    return this.userAuth.authToken !== "";
  }

  public static hasActiveSubscription() {
    const expiresAt = new Date(this.userAuth.subscription?.expiresAt ?? 0);
    return expiresAt > new Date();
  }

  static async handleExternalAuth(uri: string) {
    const callback = new URL(uri);
    if (
      callback.protocol !== "hydralauncher:" ||
      callback.hostname !== "auth"
    ) {
      throw new Error("Invalid authentication callback");
    }

    const payload = callback.searchParams.get("payload");
    if (!payload || payload.length > 16_384) {
      throw new Error("Invalid authentication payload");
    }

    let jsonData: unknown;
    try {
      jsonData = JSON.parse(atob(payload));
    } catch {
      throw new Error("Invalid authentication payload encoding");
    }

    if (
      typeof jsonData !== "object" ||
      jsonData === null ||
      typeof (jsonData as Record<string, unknown>).accessToken !== "string" ||
      typeof (jsonData as Record<string, unknown>).refreshToken !== "string" ||
      typeof (jsonData as Record<string, unknown>).expiresIn !== "number" ||
      !Number.isFinite((jsonData as Record<string, unknown>).expiresIn)
    ) {
      throw new Error("Invalid authentication payload shape");
    }

    const { accessToken, refreshToken, expiresIn } = jsonData as {
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
    };
    if (
      !accessToken ||
      !refreshToken ||
      expiresIn <= 0 ||
      expiresIn > 31_536_000
    ) {
      throw new Error("Invalid authentication token data");
    }

    const now = new Date();

    const tokenExpirationTimestamp =
      now.getTime() +
      this.secondsToMilliseconds(expiresIn) -
      this.EXPIRATION_OFFSET_IN_MS;

    this.userAuth = {
      authToken: accessToken,
      refreshToken: refreshToken,
      expirationTimestamp: tokenExpirationTimestamp,
      subscription: null,
    };

    logger.log(
      "Sign in received. Token expiration timestamp:",
      tokenExpirationTimestamp
    );

    db.put<string, Auth>(
      levelKeys.auth,
      {
        accessToken,
        refreshToken,
        tokenExpirationTimestamp,
      },
      { valueEncoding: "json" }
    );

    await getUserData().then((userDetails) => {
      if (userDetails?.subscription) {
        this.userAuth.subscription = {
          expiresAt: userDetails.subscription.expiresAt
            ? new Date(userDetails.subscription.expiresAt)
            : null,
        };
      }
    });

    if (WindowManager.mainWindow) {
      WindowManager.mainWindow.webContents.send("on-signin");
      await clearGamesRemoteIds();
      uploadGamesBatch();

      WSClient.close();
      WSClient.connect();

      const { syncDownloadSourcesFromApi } = await import("./user");
      syncDownloadSourcesFromApi();
    }
  }

  static handleSignOut() {
    this.userAuth = {
      authToken: "",
      refreshToken: "",
      expirationTimestamp: 0,
      subscription: null,
    };

    this.post("/auth/logout", {}, { needsAuth: false }).catch(() => {});
  }

  static async setupApi() {
    // http(s)Agent defaults (Cloudflare DNS lookup) are set in cloudflare-dns.ts
    this.instance = axios.create({
      baseURL: appConfig.apiUrl,
      headers: { "User-Agent": `Leak Launcher v${appVersion}` },
    });

    if (this.ADD_LOG_INTERCEPTOR) {
      this.instance.interceptors.request.use(
        (request) => {
          logger.log(" ---- REQUEST -----");
          const data = Array.isArray(request.data)
            ? request.data
            : omit(request.data, ["refreshToken"]);
          logger.log(request.method, request.url, request.params, data);
          return request;
        },
        (error) => {
          logger.error("request error", error);
          return Promise.reject(error);
        }
      );
      this.instance.interceptors.response.use(
        (response) => {
          logger.log(" ---- RESPONSE -----");
          const data = Array.isArray(response.data)
            ? response.data
            : omit(response.data, ["username", "accessToken", "refreshToken"]);
          logger.log(
            response.status,
            response.config.method,
            response.config.url,
            data
          );
          return response;
        },
        (error) => {
          logger.error(" ---- RESPONSE ERROR -----");
          const { config } = error;

          const data = JSON.parse(config.data ?? null);

          logger.error(
            config.method,
            config.baseURL,
            config.url,
            omit(config.headers, [
              "accessToken",
              "refreshToken",
              "Authorization",
            ]),
            Array.isArray(data)
              ? data
              : omit(data, ["accessToken", "refreshToken"])
          );
          if (error.response) {
            logger.error(
              "Response error:",
              error.response.status,
              error.response.data
            );

            return Promise.reject(error as Error);
          }

          if (error.request) {
            const errorData = error.toJSON();
            logger.error("Request error:", errorData.code, errorData.message);
            return Promise.reject(
              new Error(
                `Request failed with ${errorData.code} ${errorData.message}`
              )
            );
          }

          logger.error("Error", error.message);
          return Promise.reject(error as Error);
        }
      );
    }

    const result = await db.getMany<string>([levelKeys.auth, levelKeys.user], {
      valueEncoding: "json",
    });

    const userAuth = result.at(0) as Auth | undefined;
    const user = result.at(1) as User | undefined;

    this.userAuth = {
      authToken: userAuth?.accessToken ?? "",
      refreshToken: userAuth?.refreshToken ?? "",
      expirationTimestamp: userAuth?.tokenExpirationTimestamp ?? 0,
      subscription: user?.subscription
        ? { expiresAt: user.subscription?.expiresAt }
        : null,
    };

    // Never await network during setupApi — splash/main window must open offline.
    void getUserData()
      .then((updatedUserData) => {
        this.userAuth.subscription = updatedUserData?.subscription
          ? {
              expiresAt: updatedUserData.subscription.expiresAt,
            }
          : null;
      })
      .catch((error) => {
        logger.error("setupApi: getUserData failed (continuing)", error);
      });
  }

  private static sendSignOutEvent() {
    if (WindowManager.mainWindow) {
      WindowManager.mainWindow.webContents.send("on-signout");
    }
  }

  public static async refreshToken() {
    const response = await this.instance.post(`/auth/refresh`, {
      refreshToken: this.userAuth.refreshToken,
    });

    const { accessToken, expiresIn } = response.data;

    const tokenExpirationTimestamp =
      Date.now() +
      this.secondsToMilliseconds(expiresIn) -
      this.EXPIRATION_OFFSET_IN_MS;

    this.userAuth.authToken = accessToken;
    this.userAuth.expirationTimestamp = tokenExpirationTimestamp;

    logger.log(
      "Token refreshed. New expiration:",
      this.userAuth.expirationTimestamp
    );

    await db
      .get<string, Auth>(levelKeys.auth, { valueEncoding: "json" })
      .then((auth) => {
        return db.put<string, Auth>(
          levelKeys.auth,
          {
            ...auth,
            accessToken,
            tokenExpirationTimestamp,
          },
          { valueEncoding: "json" }
        );
      });

    return { accessToken, expiresIn };
  }

  private static async revalidateAccessTokenIfExpired() {
    if (this.userAuth.expirationTimestamp < Date.now()) {
      try {
        await this.refreshToken();
      } catch (err) {
        this.handleUnauthorizedError(err);
      }
    }
  }

  private static getAxiosConfig() {
    return {
      headers: {
        Authorization: `Bearer ${this.userAuth.authToken}`,
      },
    };
  }

  private static readonly handleUnauthorizedError = (err) => {
    if (err instanceof AxiosError && err.response?.status === 401) {
      logger.error("401 - clearing current credentials", err.response?.data);

      this.userAuth = {
        authToken: "",
        expirationTimestamp: 0,
        refreshToken: "",
        subscription: null,
      };

      db.batch([
        {
          type: "del",
          key: levelKeys.auth,
        },
        {
          type: "del",
          key: levelKeys.user,
        },
      ]);

      this.sendSignOutEvent();
    }

    throw err;
  };

  private static async validateOptions(options?: ApiClientOptions) {
    const needsAuth = options?.needsAuth == undefined || options.needsAuth;
    const needsSubscription = options?.needsSubscription === true;

    if (needsAuth) {
      if (!this.isLoggedIn()) throw new UserNotLoggedInError();
      await this.revalidateAccessTokenIfExpired();
    }

    if (needsSubscription && !this.hasActiveSubscription()) {
      throw new SubscriptionRequiredError();
    }
  }

  static async get<T = any>(
    url: string,
    params?: any,
    options?: ApiClientOptions
  ) {
    await this.validateOptions(options);

    const headers = {
      ...this.getAxiosConfig().headers,
      "Hydra-If-Modified-Since": options?.ifModifiedSince?.toUTCString(),
    };

    return this.instance
      .get<T>(url, { params, ...this.getAxiosConfig(), headers })
      .then((response) => response.data)
      .catch(this.handleUnauthorizedError);
  }

  static async post<T = any>(
    url: string,
    data?: any,
    options?: ApiClientOptions
  ) {
    await this.validateOptions(options);

    return this.instance
      .post<T>(url, data, this.getAxiosConfig())
      .then((response) => response.data)
      .catch(this.handleUnauthorizedError);
  }

  static async put<T = any>(
    url: string,
    data?: any,
    options?: ApiClientOptions
  ) {
    await this.validateOptions(options);

    return this.instance
      .put<T>(url, data, this.getAxiosConfig())
      .then((response) => response.data)
      .catch(this.handleUnauthorizedError);
  }

  static async patch<T = any>(
    url: string,
    data?: any,
    options?: ApiClientOptions
  ) {
    await this.validateOptions(options);

    return this.instance
      .patch<T>(url, data, this.getAxiosConfig())
      .then((response) => response.data)
      .catch(this.handleUnauthorizedError);
  }

  static async delete<T = any>(url: string, options?: ApiClientOptions) {
    await this.validateOptions(options);

    return this.instance
      .delete<T>(url, this.getAxiosConfig())
      .then((response) => response.data)
      .catch(this.handleUnauthorizedError);
  }

  static async checkDownloadSourcesChanges(
    downloadSourceIds: string[],
    games: Array<{ shop: string; objectId: string }>,
    since: string
  ) {
    logger.info("ApiClient.checkDownloadSourcesChanges called with:", {
      downloadSourceIds,
      gamesCount: games.length,
      since,
      isLoggedIn: this.isLoggedIn(),
    });

    try {
      const result = await this.post<
        Array<{
          shop: string;
          objectId: string;
          newDownloadOptionsCount: number;
          downloadSourceIds: string[];
        }>
      >(
        "/download-sources/changes",
        {
          downloadSourceIds,
          games,
          since,
        },
        { needsAuth: true }
      );

      logger.info(
        "ApiClient.checkDownloadSourcesChanges completed successfully:",
        result
      );
      return result;
    } catch (error) {
      logger.error("ApiClient.checkDownloadSourcesChanges failed:", error);
      throw error;
    }
  }
}
