import { useTranslation } from "react-i18next";

import type { LibraryGame } from "@types";
import { CloudSyncPanel } from "../../cloud-sync/cloud-sync-panel";

interface CloudSaveSettingsSectionProps {
  game: LibraryGame;
}

export function CloudSaveSettingsSection({
  game,
}: Readonly<CloudSaveSettingsSectionProps>) {
  const { t } = useTranslation("game_details");

  if (game.shop === "custom") {
    return (
      <p className="game-options-modal__category-note">
        {t("settings_not_available_for_custom_games")}
      </p>
    );
  }

  return (
    <div className="game-options-modal__cloud-panel">
      <CloudSyncPanel />
    </div>
  );
}
