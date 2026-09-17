import type { DitherColor } from "../dither-kit";
import { PALETTE, type Rgb, rgb } from "../dither-kit/palette";

/**
 * Ordered host palette. The local host always takes the first slot (green,
 * the theme accent); remote hosts follow in registration order so a colour
 * sticks to a host as the fleet grows. Past six hosts the cycle repeats.
 */
export const HOST_PALETTE = [
	"green",
	"blue",
	"purple",
	"pink",
	"orange",
	"red",
] as const satisfies readonly DitherColor[];

export type HostColor = (typeof HOST_PALETTE)[number];

export const hostColorAt = (index: number): HostColor =>
	HOST_PALETTE[index % HOST_PALETTE.length] ?? "green";

/** The dither fill of a palette colour as a CSS colour, with optional alpha. */
export const hostCss = (color: DitherColor, alpha = 1) =>
	rgb(PALETTE[color].fill, 1, alpha);

const hueOf = ([r, g, b]: Rgb): number => {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	if (d === 0) return 0;
	let h: number;
	if (max === r) h = ((g - b) / d) % 6;
	else if (max === g) h = (b - r) / d + 2;
	else h = (r - g) / d + 4;
	return Math.round(((h * 60) % 360) + (h < 0 ? 360 : 0));
};

/** Hue (0–360) of a palette colour — feeds `DitherAvatar` so avatars match their host's series. */
export const hostHue = (color: DitherColor) => hueOf(PALETTE[color].fill);
