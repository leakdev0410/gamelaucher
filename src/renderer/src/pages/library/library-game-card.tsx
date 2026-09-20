import { LibraryGame } from "@types";
import { useGameCard } from "@renderer/hooks";
import { memo, useCallback, useEffect, useState } from "react";
import { TrophyIcon, ImageIcon, PlayIcon } from "@primer/octicons-react";
import { useTranslation } from "react-i18next";
import cn from "classnames";
import "./library-game-card.scss";
import { logger } from "@renderer/logger";

interface LibraryGameCardProps {
  game: LibraryGame;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onContextMenu: (
    game: LibraryGame,
    position: { x: number; y: number }
  ) => void;
  onShowTooltip?: (gameId: string) => void;
  onHideTooltip?: () => void;
}

export const LibraryGameCard = memo(function LibraryGameCard({
  game,
  onMouseEnter,
  onMouseLeave,
  onContextMenu,
}: Readonly<LibraryGameCardProps>) {
  const { t } = useTranslation("library");
  const { handleCardClick, handleContextMenuClick } = useGameCard(
    game,
    onContextMenu
  );

  const isInstalled = Boolean(game.executablePath);

  const sources = [
    game.customIconUrl, // Level 0
    game.coverImageUrl, // Level 1
    game.libraryImageUrl, // Level 2
    game.iconUrl, // Level 3
  ].filter((url) => url && url.trim() !== "");

  const [fallbackIndex, setFallbackIndex] = useState(0);
  const [imageError, setImageError] = useState(false);

  const resolveImageSource = (imageUrl: string | null | undefined): string => {
    if (!imageUrl) return "";

    const trimmedImageUrl = imageUrl.trim();
    if (!trimmedImageUrl) return "";

    if (
      trimmedImageUrl.startsWith("http://") ||
      trimmedImageUrl.startsWith("https://") ||
      trimmedImageUrl.startsWith("data:") ||
      trimmedImageUrl.startsWith("blob:")
    ) {
      return trimmedImageUrl;
    }

    if (trimmedImageUrl.startsWith("local:")) {
      const normalizedLocalPath = trimmedImageUrl
        .slice("local:".length)
        .replaceAll("\\", "/");
      return `local:${normalizedLocalPath}`;
    }

    const normalizedPath = trimmedImageUrl.replaceAll("\\", "/");
    if (/^[A-Za-z]:\//.test(normalizedPath) || normalizedPath.startsWith("/")) {
      return `local:${normalizedPath}`;
    }

    return normalizedPath;
  };

  const activeImageSource = resolveImageSource(sources[fallbackIndex]);

  const handleImageError = () => {
    logger.warn(`Image failed to load for ${game.title}`, {
      failedUrl: sources[fallbackIndex],
      level: fallbackIndex,
    });

    if (fallbackIndex < sources.length - 1) {
      setFallbackIndex((prevIndex) => prevIndex + 1);
    } else {
      setImageError(true);
    }
  };

  useEffect(() => {
    setFallbackIndex(0);
    setImageError(false);
  }, [game.id]);

  const handlePlayClick = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (!game.executablePath) return;

      void window.electron
        .openGame(
          game.shop,
          game.objectId,
          game.executablePath,
          game.launchOptions
        )
        .catch((error) => {
          logger.error("Failed to start game from library card", error);
        });
    },
    [game.executablePath, game.launchOptions, game.objectId, game.shop]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleCardClick();
      }
    },
    [handleCardClick]
  );

  return (
    <div
      role="button"
      tabIndex={0}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={cn("library-game-card__wrapper", {
        "library-game-card__wrapper--installed": isInstalled,
        "library-game-card__wrapper--not-installed": !isInstalled,
      })}
      title={game.title}
      onClick={handleCardClick}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenuClick}
    >
      <div className="library-game-card__overlay">
        {(game.achievementCount ?? 0) > 0 && (
          <div className="library-game-card__achievements">
            <div className="library-game-card__achievement-header">
              <div className="library-game-card__achievements-gap">
                <TrophyIcon
                  size={13}
                  className="library-game-card__achievement-trophy"
                />
                <span className="library-game-card__achievement-count">
                  {game.unlockedAchievementCount ?? 0} /{" "}
                  {game.achievementCount ?? 0}
                </span>
              </div>
              <span className="library-game-card__achievement-percentage">
                {Math.round(
                  ((game.unlockedAchievementCount ?? 0) /
                    (game.achievementCount ?? 1)) *
                    100
                )}
                %
              </span>
            </div>
            <div className="library-game-card__achievement-progress">
              <div
                className="library-game-card__achievement-bar"
                style={{
                  width: `${((game.unlockedAchievementCount ?? 0) / (game.achievementCount ?? 1)) * 100}%`,
                }}
              />
            </div>
          </div>
        )}
      </div>

      {isInstalled && (
        <button
          type="button"
          className="library-game-card__action-button"
          onClick={handlePlayClick}
          title={t("play")}
          aria-label={t("play")}
        >
          <PlayIcon size={18} />
        </button>
      )}

      {imageError || !activeImageSource ? (
        <div className="library-game-card__cover-placeholder">
          <ImageIcon size={48} />
        </div>
      ) : (
        <img
          src={activeImageSource}
          alt={game.title}
          className="library-game-card__game-image"
          loading="lazy"
          onError={handleImageError}
        />
      )}
    </div>
  );
});
