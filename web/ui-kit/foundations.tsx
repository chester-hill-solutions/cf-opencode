import { brandColors, BrandLockup, Logo, Typography } from "@aboiteau/ui"
import { Demo, GallerySection, Row } from "./shared"

const colourRoles: Record<keyof typeof brandColors, { role: string; usage: string }> = {
  ultramarine: { role: "Action & focus", usage: "Primary actions, links, selection and focus rings." },
  vermilion: { role: "Expressive accent", usage: "Art direction, section coding and chart series." },
  yellow: { role: "Attention", usage: "Warning status and the ink swatch; ink text sits on it." },
  paper: { role: "Surface", usage: "Warm page and reading surfaces, never a text colour." },
  ink: { role: "Reading", usage: "Body text, rules and dark fields." },
  pink: { role: "Expressive accent", usage: "Overprint, section coding and chart series." },
}

export function Foundations() {
  return (
    <>
      <GallerySection
        id="identity"
        number="01"
        accent="ultramarine"
        title="Identity"
        description="One mark, one ink. Keep the open diagonal cut clear at every size. Colour is a system, not a finish: each accent below has a job and travels with the component that uses it."
      >
        <Demo name="Brand lockup" wide surface={false}>
          <div className="specimen-grid">
            <div className="logo-specimen">
              <BrandLockup />
            </div>
            <div className="logo-specimen reversed">
              <BrandLockup />
            </div>
          </div>
        </Demo>
        <Demo name="Logo" wide>
          <Logo style={{ width: "4.5rem", height: "4rem" }} />
          <Logo style={{ width: "2rem", height: "1.75rem" }} />
          <Logo style={{ width: "1.5rem", height: "1.3125rem" }} />
          <span className="catalog-note" style={{ margin: 0 }}>
            Uses <code>currentColor</code>; the same path source generates the favicon.
          </span>
        </Demo>
      </GallerySection>

      <GallerySection
        id="colour"
        number="02"
        accent="pink"
        title="Colour"
        description="Ultramarine carries actions. Ink carries reading. Vermilion, yellow and pink are expressive accents that code sections and series. Semantic success and error colours stay separate."
      >
        <Demo name="Palette and roles" wide surface={false}>
          <div className="swatch-grid">
            {Object.entries(brandColors).map(([name, value]) => {
              const key = name as keyof typeof brandColors
              return (
                <div key={name} className="swatch-card">
                  <div className="swatch-block" style={{ background: value }} />
                  <div className="swatch-name">{name}</div>
                  <div className="swatch-hex">{value}</div>
                  <div className="swatch-role">{colourRoles[key].role}</div>
                  <p className="swatch-usage">{colourRoles[key].usage}</p>
                </div>
              )
            })}
          </div>
        </Demo>
        <Demo name="Accents in context" wide>
          <Row>
            <span className="catalog-section-number" data-accent="ultramarine" aria-hidden="true">
              01
            </span>
            <span className="catalog-section-number" data-accent="vermilion" aria-hidden="true">
              02
            </span>
            <span className="catalog-section-number" data-accent="yellow" aria-hidden="true">
              03
            </span>
            <span className="catalog-section-number" data-accent="pink" aria-hidden="true">
              04
            </span>
            <span className="catalog-section-number" data-accent="ink" aria-hidden="true">
              05
            </span>
            <span className="catalog-note" style={{ margin: 0 }}>
              The same accent set codes gallery sections, settings sections and chart series. The
              number is always present, so colour never carries meaning alone.
            </span>
          </Row>
        </Demo>
      </GallerySection>

      <GallerySection
        id="typography"
        number="03"
        accent="ink"
        title="Typography"
        description="DM Sans is the working family. Choose document semantics separately from visual hierarchy with the Typography component."
      >
        <Demo name="Type scale" wide>
          <div className="specimen-stack">
            <Typography as="p" variant="display">
              Coding agents. On your terms.
            </Typography>
            <Typography as="p" variant="title">
              A clear working surface
            </Typography>
            <Typography as="p" variant="heading">
              Section heading
            </Typography>
            <Typography variant="lead">
              Confident headings, open labels and comfortable reading. Monospace is reserved for code,
              references and small technical details.
            </Typography>
            <Typography>
              Body copy keeps a comfortable measure. The type system is shared by the settings page, the
              onboarding wizard and this gallery.
            </Typography>
            <Typography variant="caption">Caption — supporting detail</Typography>
            <Typography as="code" variant="code">
              provider/model
            </Typography>
            <Typography as="blockquote" variant="quote">
              The useful tide comes in; the destructive one stays out.
            </Typography>
          </div>
        </Demo>
        <Demo name="Weights" wide>
          <Row>
            <span style={{ fontWeight: 400 }}>Regular</span>
            <span style={{ fontWeight: 500 }}>Medium</span>
            <span style={{ fontWeight: 600 }}>Semibold</span>
            <span style={{ fontWeight: 700 }}>Bold</span>
            <span style={{ fontWeight: 800 }}>Extrabold</span>
          </Row>
        </Demo>
      </GallerySection>
    </>
  )
}
