import "dotenv/config";
import { ensureHubSpotProperties } from "../src/adapters/hubspot/real.js";

const token = process.env.HUBSPOT_TOKEN;
if (!token) {
  console.error("HUBSPOT_TOKEN is not set (see .env.example)");
  process.exit(1);
}

try {
  const result = await ensureHubSpotProperties(token);
  console.log(
    result.created
      ? `Created deal property "${result.name}".`
      : `Deal property "${result.name}" already exists.`,
  );
} catch (err) {
  console.error("Failed to ensure HubSpot properties:", err);
  process.exit(1);
}
