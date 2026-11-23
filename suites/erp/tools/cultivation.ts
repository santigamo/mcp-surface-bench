// Plant groups, plants and harvests. The world keeps no teardowns, weighings, bins, costs or Metrc ids for
// cultivation records: those fields are empty, and the filters on them are not offered.
import { bound, closeness, inList, inStatus, matches, normalizeId, normalizeIds, page, qty, ranked, sorted, within, zoned, type SortBy, type Status } from "../../../src/core/kit.ts";
import { ToolError, defineTool } from "../../../src/core/tool.ts";
import { PREFIX, plantGroupActive, type Harvest, type Id, type Plant, type PlantGroup, type World } from "../world.ts";
import { find, serial } from "./shared.ts";

type Paging = { limit?: number; cursor?: string };

const time = (iso: string) => Date.parse(iso);
const optionalId = (value: string | undefined, prefix: string) => (value === undefined ? undefined : normalizeId(value, prefix));

const licenseOf = (w: World, id: Id) => find(w.licenses, id, "license");
const licenseRef = (w: World, id: Id) => { const l = licenseOf(w, id); return { id: l.id, licenseNumber: l.licenseNumber }; };
const locationRef = (w: World, id: Id) => { const l = find(w.locations, id, "location"); return { id: l.id, name: l.name }; };

// ---------- plants ----------

const groupOf = (w: World, p: Plant) => find(w.plantGroups, p.plantGroupId, "plant group");

/** The world keeps no update time on a plant: it last changed when it last changed stage. */
const plantUpdatedAt = (p: Plant) => time(p.harvestedAt ?? p.floweredAt ?? p.plantedAt);

/** The fields search-plants and get-plant share. A plant's strain, license and location are its group's. */
function plantRow(w: World, p: Plant) {
  const g = groupOf(w, p);
  return {
    id: p.id, status: p.status, plantedAt: p.plantedAt, floweredAt: p.floweredAt, harvestedAt: p.harvestedAt,
    destroyedAt: null, // the world records no destruction time
    isMotherPlant: p.isMother, metrcLabel: p.metrcLabel, metrcStrainName: g.strainName,
    metrcPlantBatchName: g.name, // a plant group is the Metrc plant batch
    license: licenseRef(w, g.licenseId), location: locationRef(w, g.locationId),
  };
}

type PlantSearch = Paging & {
  ids?: string[]; statuses?: string[]; licenseId?: string; locationIds?: string[]; metrcStrainNames?: string[];
  floweredAfter?: string; floweredBefore?: string; plantGroupId?: string; isMother?: boolean; search?: string; sortBy?: SortBy;
};

function searchPlants(args: PlantSearch, w: World) {
  const ids = normalizeIds(args.ids, PREFIX.plant), locationIds = normalizeIds(args.locationIds, PREFIX.location);
  const licenseId = optionalId(args.licenseId, PREFIX.license), groupId = optionalId(args.plantGroupId, PREFIX.plantGroup);
  const after = bound(args.floweredAfter, "after", w.timezone), before = bound(args.floweredBefore, "before", w.timezone);
  return w.plants.filter((p) => {
    const g = groupOf(w, p);
    return inList(ids, p.id) && inList(args.statuses, p.status) && inList(locationIds, g.locationId) && inList(args.metrcStrainNames, g.strainName)
      && (!licenseId || g.licenseId === licenseId) && (!groupId || g.id === groupId) && (args.isMother === undefined || p.isMother === args.isMother)
      && within(p.floweredAt, after, before) && matches(args.search, p.metrcLabel);
  });
}

const PLANT_SORT = { PLANTED_AT: (p: Plant) => time(p.plantedAt), UPDATED_AT: plantUpdatedAt, INSERTED_AT: (p: Plant) => serial(p.id), LABEL: (p: Plant) => p.metrcLabel };

// ---------- plant groups ----------

const plantsIn = (w: World, g: PlantGroup) => w.plants.filter((p) => p.plantGroupId === g.id);

/** Plant counts by stage, from the group's plants. Tagged plants are the ones growing past the immature stage. */
function stageCounts(w: World, g: PlantGroup) {
  const plants = plantsIn(w, g);
  const count = (...statuses: Plant["status"][]) => plants.filter((p) => statuses.includes(p.status)).length;
  return { total: plants.length, immature: count("IMMATURE"), tagged: count("VEGETATIVE", "FLOWERING"), destroyed: count("DESTROYED"), harvested: count("HARVESTED") };
}

const groupUpdatedAt = (w: World, g: PlantGroup) => Math.max(time(g.plantedAt), ...plantsIn(w, g).map(plantUpdatedAt));

/** The fields search-plant-groups and get-plant-group share. */
function plantGroupRow(w: World, g: PlantGroup, n = stageCounts(w, g)) {
  return {
    id: g.id, name: g.name, metrcStrainName: g.strainName, plantedAt: g.plantedAt, complianceType: licenseOf(w, g.licenseId).complianceType,
    isActive: plantGroupActive(w, g), totalPlantsCount: n.total, immaturePlantsCount: n.immature,
    license: licenseRef(w, g.licenseId), location: locationRef(w, g.locationId),
  };
}

type PlantGroupSearch = Paging & {
  ids?: string[]; licenseIds?: string[]; locationIds?: string[]; metrcStrainNames?: string[]; status?: Status; search?: string; sortBy?: SortBy;
};

function searchPlantGroups(args: PlantGroupSearch, w: World) {
  const ids = normalizeIds(args.ids, PREFIX.plantGroup), licenseIds = normalizeIds(args.licenseIds, PREFIX.license), locationIds = normalizeIds(args.locationIds, PREFIX.location);
  return w.plantGroups.filter((g) => inList(ids, g.id) && inList(licenseIds, g.licenseId) && inList(locationIds, g.locationId) && inList(args.metrcStrainNames, g.strainName)
    && inStatus(args.status, plantGroupActive(w, g)));
}

/** How closely a plant group's name, strain or location resembles the search. */
const groupCloseness = (w: World, term: string) => (g: PlantGroup) => closeness(term, [g.name, g.strainName, find(w.locations, g.locationId, "location").name]);

// ---------- harvests ----------

/** Harvest weights are stored in grams, the world's one weight unit. */
const gramRef = (w: World) => { const u = w.unitTypes.find((t) => t.category === "WEIGHT")!; return { id: u.id, name: u.name }; };

/** The fields search-harvests and get-harvest share. */
function harvestRow(w: World, h: Harvest) {
  return {
    id: h.id, name: h.name, distruStatus: h.status, harvestedAt: h.harvestedAt, finishedDate: h.finishedDate, wetWeight: qty(h.wetWeight),
    metrcId: null, metrcStrain: { id: null, name: h.strainName }, unitType: gramRef(w),
    license: licenseRef(w, h.licenseId), location: locationRef(w, h.locationId),
  };
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar-day filter bound: the finished-date filters take YYYY-MM-DD only. */
function day(value: string | undefined, input: string): string | undefined {
  if (value !== undefined && !YMD.test(value)) throw new ToolError(`${input} takes a date as YYYY-MM-DD, not "${value}".`);
  return value;
}

/** True when a calendar day lies within inclusive bounds. An absent day never matches a set bound. */
const dayWithin = (d: string | null, after?: string, before?: string) => (!after && !before) || (d !== null && (!after || d >= after) && (!before || d <= before));

const harvestUpdatedAt = (w: World, h: Harvest) => Math.max(time(h.harvestedAt), h.finishedDate ? zoned(w.timezone, h.finishedDate).getTime() : 0);

type HarvestSearch = Paging & {
  ids?: string[]; licenseId?: string; locationIds?: string[]; metrcStrainNames?: string[]; harvestedAfter?: string; harvestedBefore?: string;
  finishedAfter?: string; finishedBefore?: string; search?: string; distruStatus?: string; excludeIds?: string[]; sortBy?: SortBy;
};

function searchHarvests(args: HarvestSearch, w: World) {
  const ids = normalizeIds(args.ids, PREFIX.harvest), excluded = normalizeIds(args.excludeIds, PREFIX.harvest) ?? [];
  const licenseId = optionalId(args.licenseId, PREFIX.license), locationIds = normalizeIds(args.locationIds, PREFIX.location);
  const after = bound(args.harvestedAfter, "after", w.timezone), before = bound(args.harvestedBefore, "before", w.timezone);
  const finishedAfter = day(args.finishedAfter, "finishedAfter"), finishedBefore = day(args.finishedBefore, "finishedBefore");
  return w.harvests.filter((h) => inList(ids, h.id) && !excluded.includes(h.id) && (!licenseId || h.licenseId === licenseId) && inList(locationIds, h.locationId)
    && inList(args.metrcStrainNames, h.strainName) && (!args.distruStatus || h.status === args.distruStatus)
    && within(h.harvestedAt, after, before) && dayWithin(h.finishedDate, finishedAfter, finishedBefore));
}

// ---------- tools ----------

export const tools = [
  defineTool<World>({
    name: "search-plants",
    supports: ["limit", "cursor", "ids", "statuses", "licenseId", "locationIds", "metrcStrainNames", "floweredAfter", "floweredBefore", "plantGroupId", "isMother", "search", "sortBy"],
    run(args: PlantSearch, { world: w }) {
      const plants = sorted(searchPlants(args, w), args.sortBy, PLANT_SORT, { field: "UPDATED_AT", direction: "DESC" });
      return page(plants, args, (p) => { const g = groupOf(w, p); return { ...plantRow(w, p), plantGroup: { id: g.id, name: g.name } }; });
    },
  }),

  defineTool<World>({
    name: "get-plant",
    supports: ["id", "includeBins"],
    run(args: { id: string; includeBins?: boolean }, { world: w }) {
      const id = normalizeId(args.id, PREFIX.plant);
      const p = w.plants.find((x) => x.id === id);
      if (!p) return { plant: null };
      const g = groupOf(w, p);
      const strain = w.strains.find((s) => s.name === g.strainName)!;
      return {
        plant: {
          ...plantRow(w, p),
          // Not kept by the world: Metrc's own phase and status, weighings (so no weight unit) and costs.
          growthPhase: null, wetWeight: null, cost: null, metrcStatus: null, unitType: null, metrcPlant: null,
          complianceType: licenseOf(w, g.licenseId).complianceType,
          metrcStrain: { id: strain.id, name: strain.name },
          teardowns: [],
          plantGroup: { id: g.id, name: g.name, metrcStrainName: g.strainName, plantedAt: g.plantedAt, location: locationRef(w, g.locationId) },
          // Bin tracking is off for the company (get-me), so a plant is in no bin.
          ...(args.includeBins ? { bins: [] } : {}),
        },
      };
    },
  }),

  defineTool<World>({
    name: "search-plant-groups",
    supports: ["limit", "cursor", "ids", "licenseIds", "locationIds", "metrcStrainNames", "status", "search", "sortBy"],
    run(args: PlantGroupSearch, { world: w }) {
      const found = searchPlantGroups(args, w);
      // With search, closeness ranks and sortBy is ignored.
      const groups = args.search
        ? ranked(found, groupCloseness(w, args.search))
        : sorted(found, args.sortBy, { NAME: (g) => g.name, PLANTED_AT: (g) => time(g.plantedAt), INSERTED_AT: (g) => serial(g.id), UPDATED_AT: (g) => groupUpdatedAt(w, g) }, { field: "UPDATED_AT", direction: "DESC" });
      return page(groups, args, (g) => plantGroupRow(w, g));
    },
  }),

  defineTool<World>({
    name: "get-plant-group",
    supports: ["id", "includeBins"],
    run(args: { id: string; includeBins?: boolean }, { world: w }) {
      const id = normalizeId(args.id, PREFIX.plantGroup);
      const g = w.plantGroups.find((x) => x.id === id);
      if (!g) return { plantGroup: null };
      const n = stageCounts(w, g);
      return {
        plantGroup: {
          ...plantGroupRow(w, g, n),
          metrcStrainId: w.strains.find((s) => s.name === g.strainName)?.id ?? null,
          taggedPlantsCount: n.tagged, destroyedPlantsCount: n.destroyed, harvestedPlantsCount: n.harvested,
          packagedPlantsCount: 0, // the world has no packaged plant status
          // Not kept by the world: costs, Metrc's id for the batch and its source lineage.
          cost: null, metrcId: null, metrcSourcePackageLabel: null, metrcSourcePlantBatchNames: null, metrcSourcePlantLabel: null,
          firstRecordedAt: g.plantedAt,
          ...(args.includeBins ? { bins: [] } : {}),
        },
      };
    },
  }),

  defineTool<World>({
    name: "search-harvests",
    supports: ["limit", "cursor", "ids", "licenseId", "locationIds", "metrcStrainNames", "harvestedAfter", "harvestedBefore", "finishedAfter", "finishedBefore", "search", "distruStatus", "excludeIds", "sortBy"],
    run(args: HarvestSearch, { world: w }) {
      let harvests = searchHarvests(args, w);
      // With search, name similarity ranks; an explicit sortBy ranks first and similarity breaks its ties (the sort is stable).
      if (args.search) harvests = ranked(harvests, (h) => closeness(args.search!, [h.name]));
      if (!args.search || args.sortBy) {
        harvests = sorted(harvests, args.sortBy, { NAME: (h) => h.name, HARVESTED_AT: (h) => time(h.harvestedAt), INSERTED_AT: (h) => serial(h.id), UPDATED_AT: (h) => harvestUpdatedAt(w, h) }, { field: "UPDATED_AT", direction: "DESC" });
      }
      return page(harvests, args, (h) => ({ ...harvestRow(w, h), submittedToMetrcAt: null }));
    },
  }),

  defineTool<World>({
    name: "get-harvest",
    supports: ["id", "includeBreakdowns"],
    run(args: { id: string; includeBreakdowns?: boolean }, { world: w }) {
      const id = normalizeId(args.id, PREFIX.harvest);
      const h = w.harvests.find((x) => x.id === id);
      if (!h) return { harvest: null };
      return {
        harvest: {
          ...harvestRow(w, h),
          // Not kept by the world: dry, waste and packaged weights, costs, who it was grown for and its teardown.
          wasteWeight: null, packagedWeight: null, totalCost: null, costPerGram: null, wasteCost: null, packagedCost: null, moistureLossCost: null,
          grownFor: null, teardown: null,
          ...(args.includeBreakdowns ? { breakdowns: [] } : {}),
        },
      };
    },
  }),
];
