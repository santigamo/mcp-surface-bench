import type { Suite } from "../../src/core/tool.ts";
import { clock, createWorld } from "./seed.ts";
import { tasks } from "./tasks.ts";
import { tools as catalog } from "./tools/catalog.ts";
import { tools as commerce } from "./tools/commerce.ts";
import { tools as compliance } from "./tools/compliance.ts";
import { tools as cultivation } from "./tools/cultivation.ts";
import { tools as directory } from "./tools/directory.ts";
import { tools as history } from "./tools/history.ts";
import { tools as inventory } from "./tools/inventory.ts";
import { tools as orders } from "./tools/orders.ts";
import { tools as purchasing } from "./tools/purchasing.ts";
import { tools as session } from "./tools/session.ts";
import type { World } from "./world.ts";

/** A cannabis distributor and grower in California, with a year of sales, purchasing, inventory and compliance history. */
export const erp: Suite<World> = {
  name: "erp",
  createWorld,
  clock,
  handlers: [...session, ...catalog, ...inventory, ...orders, ...purchasing, ...directory, ...commerce, ...compliance, ...cultivation, ...history],
  tasks,
};
