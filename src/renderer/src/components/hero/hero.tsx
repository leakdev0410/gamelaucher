import { useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import type { TrendingGame } from "@types";
import { useTranslation } from "react-i18next";
import Skeleton from "react-loading-skeleton";
import { ArrowRightIcon } from "@primer/octicons-react";
import "./hero.scss";

export function Hero() {
  const [featuredGameDetails, setFeaturedGameDetails] = useState<
    TrendingGame[] | null
  >(null);
  const [isLoading, setIsLoading] = useState(false);

  const { i18n, t } = useTranslation("home");

  const navigate = useNavigate();

  useEffect(() => {
    setIsLoading(true);

    const language = i18n.language.split("-")[0];

    window.electron.api
      .get<TrendingGame[]>("/catalogue/featured", {
        params: { language },
        needsAuth: false,
      })
      .then((result) => {
        setFeaturedGameDetails(result.slice(0, 1));
      })
      .catch(() => {
        setFeaturedGameDetails([]);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [i18n.language]);

  if (isLoading) {
    return <Skeleton className="hero" />;
  }

  if (!featuredGameDetails?.length) {
    return null;
  }

  return featuredGameDetails.map((game) => {
    const goToGame = () => navigate(game.uri);

    return (
      <div
        className="hero"
        key={game.uri}
        role="button"
        tabIndex={0}
        onClick={goToGame}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            goToGame();
          }
        }}
      >
        <img
          src={game.libraryHeroImageUrl ?? undefined}
          alt={game.description ?? ""}
          className="hero__media"
          loading="eager"
        />
        <div className="hero__scrim" />

        <div className="hero__content">
          <span className="hero__eyebrow">{t("featured")}</span>

          {game.logoImageUrl ? (
            <img
              src={game.logoImageUrl}
              alt={game.title}
              loading="eager"
              className="hero__logo"
            />
          ) : (
            <h1 className="hero__title">{game.title}</h1>
          )}

          {game.description && (
            <p className="hero__description">{game.description}</p>
          )}

          <div className="hero__actions">
            <button
              type="button"
              className="hero__cta hero__cta--primary"
              onClick={(event) => {
                event.stopPropagation();
                goToGame();
              }}
            >
              {t("explore")}
              <ArrowRightIcon size={16} />
            </button>

            <button
              type="button"
              className="hero__cta hero__cta--secondary"
              onClick={(event) => {
                event.stopPropagation();
                navigate("/library");
              }}
            >
              {t("library")}
            </button>
          </div>
        </div>
      </div>
    );
  });
}
