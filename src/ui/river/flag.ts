// The river of money (П2) is shown only when the deployment says "on" (NEXT_PUBLIC_RIVER, read when the app is built),
// the same switch as the landing page's second demo drive (src/ui/demo-flags.ts).

export const riverOn = (value: string | null | undefined): boolean => value?.trim().toLowerCase() === "on";
