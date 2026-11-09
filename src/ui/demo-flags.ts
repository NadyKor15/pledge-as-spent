// Switches for what the landing page offers. NEXT_PUBLIC_* values are read when the app is built.

/** The second demo drive (a hurricane relief drive in Florida) is offered only when the deployment says "on". */
export const floridaDemoOn = (value: string | null | undefined): boolean => value?.trim().toLowerCase() === "on";

/** The scenario id POST /api/demo/drives takes for it. */
export const FLORIDA_SCENARIO = "florida";
