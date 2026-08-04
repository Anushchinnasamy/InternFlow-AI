import "dotenv/config";
import cron from "node-cron";
import { app } from "./app";
import { runSlaSweep } from "./lib/slaSweep";
import { runWeeklyDigest } from "./lib/weeklyDigest";

// Day 6: the SLA sweep is compliance-critical (breach detection, escalation
// tiers), so it runs frequently. runSlaSweep()/runWeeklyDigest() are also
// exported standalone for manual/verification runs — this cron registration
// is just the scheduled trigger, not the only entry point.
cron.schedule("*/5 * * * *", () => {
  runSlaSweep().catch((err) => console.error("[slaSweep] failed:", err));
});

// Weekly digest — Monday 09:00, its own cadence rather than piggybacking on
// the every-5-minutes sweep.
cron.schedule("0 9 * * 1", () => {
  runWeeklyDigest().catch((err) => console.error("[weeklyDigest] failed:", err));
});

const PORT = Number(process.env.PORT ?? 4000);
app.listen(PORT, () => {
  console.log(`Intern Flow backend listening on port ${PORT}`);
});
