/** Optical tracing of the A/slash mark approved on 2026-11-06. */
export const logoViewBox = "160 220 940 790"
export const logoPaths = [
  "M612 235H668Q702 235 719 265L865 519L731 574L653 449Q640 432 627 449L501 664L286 758L568 263Q584 235 612 235Z",
  "M225 868L905 590L1085 970Q1098 997 1069 997H904Q881 997 871 975L801 806Q795 789 778 789H515Q498 789 491 805L420 975Q411 997 388 997H194Q163 997 176 971Z",
] as const

export type BrandAccent = keyof typeof brandColors

export const brandColors = {
  ultramarine: "#1746D1",
  vermilion: "#F04B32",
  yellow: "#F7D447",
  paper: "#F6EEDD",
  ink: "#212722",
  pink: "#ED5798",
} as const

export const logoBox = { x: 160, y: 220, width: 940, height: 790 }

/**
 * B3 "Squeegee print" colour blocking, approved 2026-11-06.
 *
 * The fields are drawn over an ultramarine base and clipped to `logoPaths`, so
 * every edge follows the mark. The approved reference carries a restrained
 * screenprint grain; the UI and favicon use flat inks because the mark is drawn
 * from 1.3rem up and must stay crisp.
 */
export const logoColourFields = [
  {
    ink: "yellow",
    d: "M200 820L568 263L720 330L640 432L505 650L310 715Z",
  },
  {
    ink: "vermilion",
    d: "M150 1005L150 850L860 600L880 700L800 790L515 789L491 805L430 1005Z",
  },
  { ink: "pink", d: "M760 640L1040 600L1040 700L800 760Z" },
] as const satisfies readonly { ink: keyof typeof brandColors; d: string }[]

/** Standalone favicon SVG from the same paths and fields as the React mark. */
export function logoSvgMarkup(id = "abo-logo-clip"): string {
  const clip = logoPaths.map((path) => `<path d="${path}"/>`).join("")
  const fields = logoColourFields
    .map((field) => `<path d="${field.d}" fill="${brandColors[field.ink]}"/>`)
    .join("")
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${logoViewBox}">` +
    `<title>Aboiteau</title><defs><clipPath id="${id}" clipPathUnits="userSpaceOnUse">${clip}</clipPath></defs>` +
    `<g clip-path="url(#${id})">` +
    `<rect x="${logoBox.x}" y="${logoBox.y}" width="${logoBox.width}" height="${logoBox.height}" fill="${brandColors.ultramarine}"/>` +
    `${fields}</g></svg>\n`
  )
}
