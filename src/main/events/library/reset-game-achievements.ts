import { registerEvent } from "../register-event";
import { findAchievementFiles } from "@main/services/achievements/find-achivement-files";
import fs from "fs";
import { achievementsLogger, ApiClient, WindowManager } from "@main/services";
import { getUnlockedAchievements } from "../user/get-unlocked-achievements";
import {
  gameAchievementsSublevel,
  gamesSublevel,
  levelKeys,
} from "@main/level";
import type { GameShop } from "@types";

const resetGameAchievements = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
) => {
  try {
    const levelKey = levelKeys.game(shop, objectId);
    const game = await gamesSublevel.get(levelKey);

    if (!game) return;

    const achievementFiles = await findAchievementFiles(game);

    if (achievementFiles.length) {
      for (const achievementFile of achievementFiles) {
        achievementsLogger.log(`deleting ${achievementFile.filePath}`);
        await fs.promises.rm(achievementFile.filePath);
      }
    }

    const gameAchievementsData = await gameAchievementsSublevel
      .get(levelKey)
      .catch(() => null);

    if (gameAchievementsData) {
      await gameAchievementsSublevel.put(levelKey, {
        ...gameAchievementsData,
        unlockedAchievements: [],
      });
    }

    if (game.remoteId) {
      await ApiClient.delete(`/profile/games/achievements/${game.remoteId}`);
      achievementsLogger.log(
        `Deleted achievements from ${game.remoteId} - ${game.objectId} - ${game.title}`
      );
    } else {
      achievementsLogger.log(
        `Deleted local achievements for ${game.objectId} - ${game.title}`
      );
    }

    const gameAchievements = await getUnlockedAchievements(
      game.objectId,
      game.shop,
      true
    );

    WindowManager.mainWindow?.webContents.send(
      `on-update-achievements-${game.objectId}-${game.shop}`,
      gameAchievements
    );
  } catch (error) {
    achievementsLogger.error(error);
    throw error;
  }
};

registerEvent("resetGameAchievements", resetGameAchievements);
