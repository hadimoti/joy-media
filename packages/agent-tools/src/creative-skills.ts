/**
 * Product-owned R1 recipe catalog. The manifest contract and availability
 * computation live in `creative-skill.ts`; this entry point keeps consumers
 * from coupling themselves to the internal catalog layout.
 */
export { CREATIVE_SKILLS, getCreativeSkill } from './creative-skill.js';
