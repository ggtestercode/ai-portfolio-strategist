import { db, profileTable } from "@workspace/db";

export async function getProfile() {
  const [profile] = await db.select().from(profileTable).limit(1);
  if (!profile) {
    throw new Error("Profile is not seeded");
  }
  return profile;
}
