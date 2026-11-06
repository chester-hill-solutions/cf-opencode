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
