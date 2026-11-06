# Colour pair checks

Calculated from opaque six-digit sRGB design tokens. These checks cover the listed pairs; they do not establish whole-page accessibility.

| Pair | Foreground | Background | Contrast |
| --- | --- | --- | --- |
| Ink / paper | #212722 | #F6EEDD | 13.20:1 |
| White / ultramarine | #FFFFFF | #1746D1 | 7.41:1 |
| Muted / surface | #62665F | #FFFDF8 | 5.76:1 |
| Error / surface | #B72E22 | #FFFDF8 | 6.03:1 |
| Ink / yellow | #212722 | #F7D447 | 10.50:1 |
| White / vermilion strong | #FFFFFF | #CF3F28 | 4.78:1 |
| Ink / pink strong | #212722 | #ED5798 | 4.66:1 |
| Input border / surface | #858A80 | #FFFDF8 | 3.48:1 |

Use ink on yellow and pink. Use white on ultramarine and on the darker vermilion `accent-strong` surface. The raw vermilion and pink are artwork accents, not body text colours; a text-bearing accent chip uses `--abo-accent-strong` and its checked `--abo-accent-ink`. Interactive boundaries use a darker neutral than decorative dividers.

