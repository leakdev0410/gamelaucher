import { ApiClient } from "@main/services";
import type { UpdateProfileRequest, UserProfile } from "@types";

export const patchUserProfile = async (updateProfile: UpdateProfileRequest) => {
  return ApiClient.patch<UserProfile>("/profile", updateProfile);
};
