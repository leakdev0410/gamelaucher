import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeftIcon,
  BellIcon,
  SearchIcon,
  SyncIcon,
  XIcon,
} from "@primer/octicons-react";
import { Tooltip } from "react-tooltip";
import cn from "classnames";
import { debounce } from "lodash-es";

import {
  useAppDispatch,
  useAppSelector,
  useDownload,
  useSearchHistory,
  useSearchSuggestions,
} from "@renderer/hooks";
import { setFilters, setLibrarySearchQuery } from "@renderer/features";
import { SearchDropdown } from "@renderer/components";
import { buildGameDetailsPath } from "@renderer/helpers";
import type { GameShop } from "@types";

import appIcon from "@renderer/assets/app-icon.png";
import { ScanGamesModal } from "../header/scan-games-modal";
import { topNavRoutes } from "./routes";
import "./top-nav.scss";

function isRouteActive(pathname: string, routePath: string) {
  if (routePath === "/") return pathname === "/";
  return pathname === routePath || pathname.startsWith(`${routePath}/`);
}

export function TopNav() {
  const inputRef = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const scanButtonTooltipId = useId();

  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const dispatch = useAppDispatch();
  const { t } = useTranslation(["sidebar", "header"]);
  const { lastPacket } = useDownload();

  const catalogueSearchValue = useAppSelector(
    (state) => state.catalogueSearch.filters.title
  );
  const librarySearchValue = useAppSelector(
    (state) => state.library.searchQuery
  );

  const isOnLibraryPage = location.pathname.startsWith("/library");
  const isOnCataloguePage = location.pathname.startsWith("/catalogue");
  const isOnNotifications = location.pathname.startsWith("/notifications");
  const isOnGameDetails = location.pathname.startsWith("/game/");
  // Show back on game pages always; elsewhere only if we have history.
  const showBackButton =
    isOnGameDetails ||
    location.pathname.startsWith("/achievements") ||
    (location.key !== "default" &&
      ![
        "/",
        "/library",
        "/catalogue",
        "/downloads",
        "/settings",
        "/notifications",
      ].includes(location.pathname));

  const searchValue = isOnLibraryPage
    ? librarySearchValue
    : catalogueSearchValue;

  const [localSearchValue, setLocalSearchValue] = useState(searchValue);
  const deferredSearchValue = useDeferredValue(localSearchValue);
  const [isFocused, setIsFocused] = useState(false);
  const [isDropdownVisible, setIsDropdownVisible] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dropdownPosition, setDropdownPosition] = useState({ x: 0, y: 0 });
  const [showScanModal, setShowScanModal] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<{
    foundGames: Array<{ title: string; executablePath: string }>;
    total: number;
  } | null>(null);

  const debouncedLibrarySearch = useMemo(
    () =>
      debounce((value: string) => {
        dispatch(setLibrarySearchQuery(value));
      }, 180),
    [dispatch]
  );

  const debouncedCatalogueSearch = useMemo(
    () =>
      debounce((value: string) => {
        dispatch(setFilters({ title: value }));
      }, 250),
    [dispatch]
  );

  const { addToHistory, removeFromHistory, clearHistory, getRecentHistory } =
    useSearchHistory();

  const { suggestions, isLoading: isLoadingSuggestions } = useSearchSuggestions(
    deferredSearchValue,
    isOnLibraryPage,
    isDropdownVisible && isFocused && !isOnCataloguePage
  );

  const historyItems = getRecentHistory(
    isOnLibraryPage ? "library" : "catalogue",
    3
  );

  const totalItems = historyItems.length + suggestions.length;
  const downloadBadge = lastPacket ? 1 : 0;

  useEffect(() => {
    setLocalSearchValue(searchValue);
  }, [searchValue, isOnLibraryPage, isOnCataloguePage]);

  useEffect(() => {
    return () => {
      debouncedLibrarySearch.cancel();
      debouncedCatalogueSearch.cancel();
    };
  }, [debouncedCatalogueSearch, debouncedLibrarySearch]);

  const updateDropdownPosition = () => {
    if (searchContainerRef.current) {
      const rect = searchContainerRef.current.getBoundingClientRect();
      setDropdownPosition({ x: rect.left, y: rect.bottom });
    }
  };

  const handleFocus = () => {
    setIsFocused(true);
    setActiveIndex(-1);
    setTimeout(() => {
      updateDropdownPosition();
      setIsDropdownVisible(true);
    }, 120);
  };

  const handleBlur = () => {
    setTimeout(() => {
      setIsFocused(false);
      setIsDropdownVisible(false);
      setActiveIndex(-1);
    }, 200);
  };

  const handleSearch = (value: string) => {
    debouncedLibrarySearch.cancel();
    debouncedCatalogueSearch.cancel();
    if (isOnLibraryPage) {
      dispatch(setLibrarySearchQuery(value.slice(0, 255)));
    } else {
      dispatch(setFilters({ title: value.slice(0, 255) }));
    }
    setActiveIndex(-1);
  };

  const handleInputChange = (value: string) => {
    const normalizedValue = value.slice(0, 255);
    setLocalSearchValue(normalizedValue);
    setActiveIndex(-1);
    if (isOnLibraryPage) {
      debouncedCatalogueSearch.cancel();
      debouncedLibrarySearch(normalizedValue);
    } else {
      debouncedLibrarySearch.cancel();
      debouncedCatalogueSearch(normalizedValue);
    }
  };

  const executeSearch = (query: string) => {
    setLocalSearchValue(query.slice(0, 255));
    const context = isOnLibraryPage ? "library" : "catalogue";
    if (query.trim()) addToHistory(query, context);
    handleSearch(query);
    if (!isOnLibraryPage && !location.pathname.startsWith("/catalogue")) {
      navigate("/catalogue");
    }
    setIsDropdownVisible(false);
    inputRef.current?.blur();
  };

  const handleSelectSuggestion = (suggestion: {
    title: string;
    objectId: string;
    shop: GameShop;
  }) => {
    setIsDropdownVisible(false);
    inputRef.current?.blur();
    navigate(buildGameDetailsPath(suggestion));
  };

  const handleClearSearch = () => {
    debouncedLibrarySearch.cancel();
    debouncedCatalogueSearch.cancel();
    setLocalSearchValue("");
    if (isOnLibraryPage) dispatch(setLibrarySearchQuery(""));
    else dispatch(setFilters({ title: "" }));
    setActiveIndex(-1);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (activeIndex >= 0 && activeIndex < totalItems) {
        if (activeIndex < historyItems.length) {
          executeSearch(historyItems[activeIndex].query);
        } else {
          handleSelectSuggestion(
            suggestions[activeIndex - historyItems.length]
          );
        }
      } else if (localSearchValue.trim()) {
        executeSearch(localSearchValue);
      }
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => (prev < totalItems - 1 ? prev + 1 : prev));
      if (!isDropdownVisible) {
        setIsDropdownVisible(true);
        updateDropdownPosition();
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) => (prev > -1 ? prev - 1 : -1));
    } else if (event.key === "Escape") {
      event.preventDefault();
      setIsDropdownVisible(false);
      setActiveIndex(-1);
      inputRef.current?.blur();
    }
  };

  const handleStartScan = async () => {
    if (isScanning) return;
    setIsScanning(true);
    setScanResult(null);
    setShowScanModal(false);
    try {
      const result = await window.electron.scanInstalledGames();
      setScanResult(result);
    } finally {
      setIsScanning(false);
    }
  };

  useEffect(() => {
    if (searchParams.get("openScanModal") === "true") {
      setShowScanModal(true);
      searchParams.delete("openScanModal");
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (!isDropdownVisible) return;
    const handleResize = () => updateDropdownPosition();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [isDropdownVisible]);

  return (
    <>
      <nav className="topnav">
        <button
          type="button"
          className="topnav__logo"
          onClick={() => navigate("/")}
        >
          <div className="topnav__mark">
            <img src={appIcon} alt="" />
          </div>
          <div className="topnav__name">
            Game <span>Launcher</span>
          </div>
        </button>

        {showBackButton && (
          <button
            type="button"
            className="topnav__back"
            onClick={() => {
              if (window.history.length > 1 && location.key !== "default") {
                navigate(-1);
              } else if (isOnGameDetails) {
                navigate("/catalogue");
              } else {
                navigate("/");
              }
            }}
            title={t("header:back", { defaultValue: "Back" })}
            aria-label={t("header:back", { defaultValue: "Back" })}
          >
            <ArrowLeftIcon size={16} />
          </button>
        )}

        <div className="topnav__links">
          {topNavRoutes.map((route) => {
            const active = isRouteActive(location.pathname, route.path);
            const showBadge =
              "badge" in route && route.badge && downloadBadge > 0;
            return (
              <button
                key={route.path}
                type="button"
                className={cn("topnav__link", {
                  "topnav__link--active": active,
                })}
                onClick={() => navigate(route.path)}
              >
                {t(route.nameKey)}
                {showBadge && (
                  <span className="topnav__badge">{downloadBadge}</span>
                )}
              </button>
            );
          })}
        </div>

        <div
          ref={searchContainerRef}
          className={cn("topnav__search", {
            "topnav__search--focused": isFocused,
          })}
        >
          <SearchIcon size={14} />
          <input
            ref={inputRef}
            type="search"
            name="search"
            className="topnav__search-input"
            placeholder={
              isOnLibraryPage ? t("header:search_library") : t("header:search")
            }
            value={localSearchValue}
            onChange={(e) => handleInputChange(e.target.value)}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
          />
          {localSearchValue && (
            <button
              type="button"
              className="topnav__icon-btn"
              style={{ width: 28, height: 28 }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleClearSearch}
            >
              <XIcon size={12} />
            </button>
          )}
        </div>

        <div className="topnav__actions">
          {isOnLibraryPage && window.electron.platform === "win32" && (
            <button
              type="button"
              className={cn("topnav__icon-btn", {
                "topnav__icon-btn--spin": isScanning,
              })}
              onClick={() => setShowScanModal(true)}
              data-tooltip-id={scanButtonTooltipId}
              data-tooltip-content={t("header:scan_games_tooltip")}
            >
              <SyncIcon size={16} />
            </button>
          )}

          <button
            type="button"
            className={cn("topnav__icon-btn", {
              "topnav__icon-btn--active": isOnNotifications,
            })}
            onClick={() => navigate("/notifications")}
            title={t("header:notifications", { defaultValue: "Notifications" })}
          >
            <BellIcon size={16} />
          </button>
        </div>
      </nav>

      {isOnLibraryPage && window.electron.platform === "win32" && (
        <Tooltip id={scanButtonTooltipId} style={{ zIndex: 30 }} />
      )}

      <SearchDropdown
        visible={
          isDropdownVisible &&
          (localSearchValue.trim().length > 0 ||
            historyItems.length > 0 ||
            suggestions.length > 0 ||
            isLoadingSuggestions)
        }
        position={dropdownPosition}
        historyItems={historyItems}
        suggestions={suggestions}
        isLoadingSuggestions={isLoadingSuggestions}
        onSelectHistory={executeSearch}
        onSelectSuggestion={handleSelectSuggestion}
        onRemoveHistoryItem={removeFromHistory}
        onClearHistory={clearHistory}
        onClose={() => {
          setIsDropdownVisible(false);
          setActiveIndex(-1);
        }}
        activeIndex={activeIndex}
        currentQuery={deferredSearchValue}
        searchContainerRef={searchContainerRef}
      />

      <ScanGamesModal
        visible={showScanModal}
        onClose={() => setShowScanModal(false)}
        isScanning={isScanning}
        scanResult={scanResult}
        onStartScan={handleStartScan}
        onClearResult={() => setScanResult(null)}
      />
    </>
  );
}
