import "dotenv/config";
import { PgStore } from "./pg-store.js";

const store = new PgStore(process.env.DATABASE_URL!);
await store.migrate();
console.log("amend schema ready");
await store.close();
