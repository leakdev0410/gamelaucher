import { FILE_EXTENSIONS_TO_EXTRACT } from "./constants";

const RAR_PART_VOLUME_RE = /(?:^|[.\s_-])part\d+\.rar$/i;
const FIRST_RAR_PART_VOLUME_RE = /(?:^|[.\s_-])part0*1\.rar$/i;
const SPLIT_ARCHIVE_VOLUME_RE = /\.(?:7z|zip|rar)\.\d{3}$/i;
const FIRST_SPLIT_ARCHIVE_VOLUME_RE = /\.(?:7z|zip|rar)\.001$/i;
const RAR_CONTINUATION_VOLUME_RE = /\.r\d{2,3}$/i;
const TRAILING_ARCHIVE_PART_SEPARATOR_RE = /[.\s_-]+$/;

export const isArchiveFile = (fileName: string) => {
  const normalizedFileName = fileName.toLowerCase();

  return (
    FILE_EXTENSIONS_TO_EXTRACT.some((ext) =>
      normalizedFileName.endsWith(ext)
    ) ||
    SPLIT_ARCHIVE_VOLUME_RE.test(normalizedFileName) ||
    RAR_CONTINUATION_VOLUME_RE.test(normalizedFileName)
  );
};

export const isFirstArchiveVolume = (fileName: string) => {
  if (!isArchiveFile(fileName)) return false;

  if (FIRST_RAR_PART_VOLUME_RE.test(fileName)) return true;
  if (RAR_PART_VOLUME_RE.test(fileName)) return false;

  if (FIRST_SPLIT_ARCHIVE_VOLUME_RE.test(fileName)) return true;
  if (SPLIT_ARCHIVE_VOLUME_RE.test(fileName)) return false;

  if (RAR_CONTINUATION_VOLUME_RE.test(fileName)) return false;

  return true;
};

export const getArchiveExtractionRelativePath = (fileName: string) => {
  const withoutTrailingSeparators = fileName.replace(/[\\/]+$/g, "");

  const rarPartName = withoutTrailingSeparators.replace(
    FIRST_RAR_PART_VOLUME_RE,
    ""
  );
  if (rarPartName !== withoutTrailingSeparators) {
    return (
      rarPartName.replace(TRAILING_ARCHIVE_PART_SEPARATOR_RE, "") ||
      withoutTrailingSeparators.replace(/\.rar$/i, "")
    );
  }

  const splitArchiveName = withoutTrailingSeparators.replace(
    /\.(?:7z|zip|rar)\.001$/i,
    ""
  );
  if (splitArchiveName !== withoutTrailingSeparators) return splitArchiveName;

  const archiveExtension = FILE_EXTENSIONS_TO_EXTRACT.find((ext) =>
    withoutTrailingSeparators.toLowerCase().endsWith(ext)
  );

  if (archiveExtension) {
    return withoutTrailingSeparators.slice(0, -archiveExtension.length);
  }

  const splitFileName = withoutTrailingSeparators.replace(/\.001$/i, "");
  if (splitFileName !== withoutTrailingSeparators) return splitFileName;

  return withoutTrailingSeparators;
};
