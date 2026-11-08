import type { Map } from 'maplibre-gl'

// Each icon is drawn at display size in its viewBox and rasterised at 2x.
type Icon = { width: number; height: number; body: string }

const ICONS = {
  // A lock chamber with a gate at each end, drawn east-west and rotated on the
  // map to lie along the canal.
  lock: {
    width: 26,
    height: 14,
    body: `
      <rect x="1.5" y="1.5" width="23" height="11" rx="2.5" fill="#fff" stroke="#b4341f" stroke-width="2"/>
      <rect x="5" y="3.5" width="2.6" height="7" rx="0.8" fill="#b4341f"/>
      <rect x="18.4" y="3.5" width="2.6" height="7" rx="0.8" fill="#b4341f"/>
      <rect x="9.5" y="6.1" width="7" height="1.8" rx="0.9" fill="#e7a08f"/>`,
  },
  // A turning bay: a U-turn arrow in an amber disc.
  winding: {
    width: 20,
    height: 20,
    body: `
      <circle cx="10" cy="10" r="8.6" fill="#fff" stroke="#c27c00" stroke-width="1.8"/>
      <path d="M7 14.5V9a3 3 0 0 1 6 0v3" fill="none" stroke="#c27c00" stroke-width="1.9" stroke-linecap="round"/>
      <path d="M10.4 10.6 13 13.6l2.6-3" fill="none" stroke="#c27c00" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  // Three waterways meeting.
  junction: {
    width: 18,
    height: 18,
    body: `
      <circle cx="9" cy="9" r="7.8" fill="#6b4fa0" stroke="#fff" stroke-width="1.6"/>
      <path d="M9 9.6V14M9 9.6 5.2 5.6M9 9.6l3.8-4" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>`,
  },
  // An anchor on a navy badge.
  marina: {
    width: 22,
    height: 22,
    body: `
      <rect x="1" y="1" width="20" height="20" rx="5" fill="#123d73" stroke="#fff" stroke-width="1.6"/>
      <circle cx="11" cy="6.2" r="1.7" fill="none" stroke="#fff" stroke-width="1.5"/>
      <path d="M11 8v9M7.6 10.6h6.8M5.6 12.6a5.4 5.4 0 0 0 10.8 0" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>`,
  },
  // A small arch.
  bridge: {
    width: 18,
    height: 12,
    body: `
      <path d="M1.5 10.5V4.2h15v6.3h-3.2a4.3 4.3 0 0 0-8.6 0z" fill="#4b5563" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>`,
  },
} satisfies Record<string, Icon>

export type IconName = keyof typeof ICONS

const PIXEL_RATIO = 2

function svgFor({ width, height, body }: Icon, scale = 1) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}" viewBox="0 0 ${width} ${height}">${body}</svg>`
}

/** Data URL for an icon at display size, for use in an <img>. */
export function iconUrl(name: IconName) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgFor(ICONS[name]))}`
}

export function iconSize(name: IconName) {
  return { width: ICONS[name].width, height: ICONS[name].height }
}

/** Rasterise every icon and register it with the map as `icon-<name>`. */
export async function addMapIcons(map: Map) {
  await Promise.all(
    (Object.entries(ICONS) as [IconName, Icon][]).map(async ([name, icon]) => {
      const image = new Image(icon.width * PIXEL_RATIO, icon.height * PIXEL_RATIO)
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgFor(icon, PIXEL_RATIO))}`
      await image.decode()
      if (!map.hasImage(`icon-${name}`)) {
        map.addImage(`icon-${name}`, image, { pixelRatio: PIXEL_RATIO })
      }
    }),
  )
}
