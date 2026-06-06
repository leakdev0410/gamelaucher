import { Button } from "@renderer/components";
import { useContext, useEffect, useMemo, useState } from "react";
import { cloudSyncContext, gameDetailsContext } from "@renderer/context";
import "./cloud-sync-panel.scss";
import { formatBytes } from "@shared";
import {
  ClockIcon,
  DeviceDesktopIcon,
  HistoryIcon,
  InfoIcon,
  PencilIcon,
  SyncIcon,
  TrashIcon,
  UploadIcon,
} from "@primer/octicons-react";
import { useAppSelector, useDate, useFormat, useToast } from "@renderer/hooks";
import { useTranslation } from "react-i18next";
import { AxiosProgressEvent } from "axios";
import { formatDownloadProgress } from "@renderer/helpers";
import { CloudSyncRenameArtifactModal } from "../cloud-sync-rename-artifact-modal/cloud-sync-rename-artifact-modal";
import { GameArtifact } from "@types";
import { orderBy } from "lodash-es";
import { Tooltip } from "react-tooltip";

export function CloudSyncPanel() {
  const [deletingArtifact, setDeletingArtifact] = useState(false);
  const [backupDownloadProgress, setBackupDownloadProgress] =
    useState<AxiosProgressEvent | null>(null);
  const [artifactToRename, setArtifactToRename] = useState<GameArtifact | null>(
    null
  );

  const { t } = useTranslation("game_details");
  const { formatDate, formatDateTime } = useDate();
  const { formatNumber } = useFormat();

  const {
    artifacts,
    backupPreview,
    uploadingBackup,
    restoringBackup,
    loadingPreview,
    uploadSaveGame,
    downloadGameArtifact,
    deleteGameArtifact,
    setShowCloudSyncFilesModal,
    getGameBackupPreview,
    getGameArtifacts,
  } = useContext(cloudSyncContext);

  const { objectId, shop, lastDownloadedOption } =
    useContext(gameDetailsContext);

  const { showSuccessToast, showErrorToast } = useToast();

  const userDetails = useAppSelector((state) => state.userDetails.userDetails);
  const backupsPerGameLimit = userDetails?.quirks?.backupsPerGameLimit ?? 0;

  const handleDeleteArtifactClick = async (gameArtifactId: string) => {
    setDeletingArtifact(true);
    try {
      await deleteGameArtifact(gameArtifactId);
      showSuccessToast(t("backup_deleted"));
    } catch (_err) {
      showErrorToast("backup_deletion_failed");
    } finally {
      setDeletingArtifact(false);
    }
  };

  useEffect(() => {
    const removeBackupDownloadProgressListener =
      window.electron.onBackupDownloadProgress(
        objectId!,
        shop,
        (progressEvent) => {
          setBackupDownloadProgress(progressEvent);
        }
      );

    return () => {
      removeBackupDownloadProgressListener();
    };
  }, [objectId, shop]);

  useEffect(() => {
    getGameBackupPreview();
    getGameArtifacts();
  }, [getGameArtifacts, getGameBackupPreview]);

  const handleBackupInstallClick = async (artifactId: string) => {
    setBackupDownloadProgress(null);
    downloadGameArtifact(artifactId);
  };

  const hasReachedLimit =
    backupsPerGameLimit > 0 && artifacts.length >= backupsPerGameLimit;

  const backupStateLabel = useMemo(() => {
    if (uploadingBackup) {
      return (
        <span className="cloud-sync-panel__backup-state-label">
          <SyncIcon className="cloud-sync-panel__sync-icon" />
          {t("uploading_backup")}
        </span>
      );
    }
    if (restoringBackup) {
      return (
        <span className="cloud-sync-panel__backup-state-label">
          <SyncIcon className="cloud-sync-panel__sync-icon" />
          {t("restoring_backup", {
            progress: formatDownloadProgress(
              backupDownloadProgress?.progress ?? 0
            ),
          })}
        </span>
      );
    }
    if (loadingPreview) {
      return (
        <span className="cloud-sync-panel__backup-state-label">
          <SyncIcon className="cloud-sync-panel__sync-icon" />
          {t("loading_save_preview")}
        </span>
      );
    }
    if (hasReachedLimit) {
      return t("max_number_of_artifacts_reached");
    }
    if (!backupPreview) {
      return t("no_backup_preview");
    }
    if (artifacts.length === 0) {
      return t("no_backups");
    }
    return "";
  }, [
    artifacts.length,
    backupDownloadProgress?.progress,
    backupPreview,
    hasReachedLimit,
    loadingPreview,
    restoringBackup,
    t,
    uploadingBackup,
  ]);

  const disableActions = uploadingBackup || restoringBackup || deletingArtifact;

  return (
    <>
      <CloudSyncRenameArtifactModal
        visible={!!artifactToRename}
        onClose={() => setArtifactToRename(null)}
        artifact={artifactToRename}
      />

      <div className="cloud-sync-panel__section-header">
        <h2>{t("cloud_save")}</h2>
        <p>{t("cloud_save_description")}</p>
      </div>

      <div className="cloud-sync-panel__header">
        <div className="cloud-sync-panel__title-container">
          <p>{backupStateLabel}</p>
          <button
            type="button"
            className="cloud-sync-panel__manage-files-button"
            onClick={() => setShowCloudSyncFilesModal(true)}
            disabled={disableActions}
          >
            {t("manage_files")}
          </button>
        </div>

        <Button
          type="button"
          onClick={() => uploadSaveGame(lastDownloadedOption?.title ?? null)}
          disabled={
            disableActions ||
            !backupPreview?.overall.totalGames ||
            hasReachedLimit
          }
        >
          {uploadingBackup ? (
            <SyncIcon className="cloud-sync-panel__sync-icon" />
          ) : (
            <UploadIcon />
          )}
          {t("create_backup")}
        </Button>
      </div>

      <div className="cloud-sync-panel__backups-header">
        <h3>{t("backups")}</h3>
        <span className="cloud-sync-panel__backups-count">
          {formatNumber(artifacts.length)}
        </span>
      </div>

      {artifacts.length > 0 ? (
        <ul className="cloud-sync-panel__artifacts">
          {orderBy(artifacts, [(a) => !a.isFrozen], ["asc"]).map((artifact) => {
            const artifactName =
              artifact.label ??
              t("backup_from", {
                date: formatDate(artifact.createdAt),
              });

            return (
              <li key={artifact.id} className="cloud-sync-panel__artifact">
                <div className="cloud-sync-panel__artifact-info">
                  <div className="cloud-sync-panel__artifact-header">
                    <button
                      type="button"
                      className="cloud-sync-panel__artifact-label"
                      onClick={() => setArtifactToRename(artifact)}
                      data-tooltip-id="cloud-sync-artifact-name-tooltip"
                      data-tooltip-content={artifactName}
                    >
                      <span className="cloud-sync-panel__artifact-label-text">
                        {artifactName}
                      </span>
                      <PencilIcon />
                    </button>
                    <small>{formatBytes(artifact.artifactLengthInBytes)}</small>
                  </div>

                  <span className="cloud-sync-panel__artifact-meta">
                    <DeviceDesktopIcon size={14} />
                    {artifact.hostname}
                  </span>

                  <span className="cloud-sync-panel__artifact-meta">
                    <InfoIcon size={14} />
                    {artifact.downloadOptionTitle ??
                      t("no_download_option_info")}
                  </span>

                  <span className="cloud-sync-panel__artifact-meta">
                    <ClockIcon size={14} />
                    {formatDateTime(artifact.createdAt)}
                  </span>
                </div>

                <div className="cloud-sync-panel__artifact-actions">
                  <Button
                    type="button"
                    onClick={() => handleBackupInstallClick(artifact.id)}
                    disabled={disableActions}
                    theme="outline"
                  >
                    {restoringBackup ? (
                      <SyncIcon className="cloud-sync-panel__sync-icon" />
                    ) : (
                      <HistoryIcon />
                    )}
                    {t("install_backup")}
                  </Button>
                  <Button
                    type="button"
                    theme="outline"
                    onClick={() => handleDeleteArtifactClick(artifact.id)}
                    disabled={disableActions}
                    tooltip={t("delete_backup")}
                  >
                    <TrashIcon />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p>{t("no_backups_created")}</p>
      )}

      <Tooltip id="cloud-sync-artifact-name-tooltip" />
    </>
  );
}
