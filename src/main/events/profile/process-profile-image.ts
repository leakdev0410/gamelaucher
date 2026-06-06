import { NativeAddon } from "@main/services/native-addon";

export const processProfileImage = async (path: string, extension?: string) => {
  return NativeAddon.processProfileImage(path, extension);
};
