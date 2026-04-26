import { Router, type IRouter } from "express";
import { GetCurrentUserResponse } from "@workspace/api-zod";
import { getProfile } from "../lib/profile";

const router: IRouter = Router();

router.get("/me", async (_req, res): Promise<void> => {
  const profile = await getProfile();
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  const isWeekday = day >= 1 && day <= 5;
  const marketOpen = isWeekday && hour >= 13 && hour < 20;

  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const dateFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const marketTime = `${dateFmt.format(now)} • ${fmt.format(now)} EST`;

  res.json(
    GetCurrentUserResponse.parse({
      id: String(profile.id),
      name: profile.name,
      email: profile.email,
      avatarUrl: profile.avatarUrl ?? null,
      marketStatus: marketOpen ? "Open" : "Closed",
      marketTime,
    }),
  );
});

export default router;
