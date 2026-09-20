import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmationModal } from "@renderer/components";
import { useToast } from "@renderer/hooks";
import { logger } from "@renderer/logger";

interface DefenderExclusionModalProps {
  visible: boolean;
  onClose: () => void;
}

export function DefenderExclusionModal({
  visible,
  onClose,
}: Readonly<DefenderExclusionModalProps>) {
  const { t } = useTranslation("settings");
  const { showSuccessToast, showErrorToast, showWarningToast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [exclusionPath, setExclusionPath] = useState("");

  useEffect(() => {
    if (!visible) return;

    window.electron.getDefenderExclusionPath().then(setExclusionPath);
  }, [visible]);

  const handleConfirm = async () => {
    setIsSubmitting(true);

    try {
      const result = await window.electron.addDefenderExclusion();

      if (result.success) {
        showSuccessToast(
          t("windows_defender_exclusion_added"),
          t("windows_defender_exclusion_added_description")
        );
        onClose();
        return;
      }

      if (result.cancelled) {
        showWarningToast(
          t("windows_defender_exclusion_cancelled"),
          t("windows_defender_exclusion_cancelled_description")
        );
        onClose();
        return;
      }

      showErrorToast(t("windows_defender_exclusion_failed"), result.error);
    } catch (error) {
      logger.error("Failed to add Windows Defender exclusion", error);
      showErrorToast(t("windows_defender_exclusion_failed"));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ConfirmationModal
      visible={visible}
      title={t("windows_defender_exclusion_confirm_title")}
      descriptionText={t("windows_defender_exclusion_confirm_description", {
        path: exclusionPath,
      })}
      confirmButtonLabel={t("add_windows_defender_exclusion")}
      cancelButtonLabel={t("cancel")}
      buttonsIsDisabled={isSubmitting || !exclusionPath}
      onConfirm={handleConfirm}
      onClose={onClose}
    />
  );
}
