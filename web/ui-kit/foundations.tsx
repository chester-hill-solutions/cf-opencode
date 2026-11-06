import { brandColors, BrandLockup, InkField, Logo, Typography } from "@aboiteau/ui"
import { Demo, GallerySection, Row } from "./shared"

export function Foundations() {
  return (
    <>
      <GallerySection
        id="identity"
        title="Identity"
        description="One mark, one ink. Keep the open diagonal cut clear at every size, and reserve broad ink fields for expressive surfaces."
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
        <Demo name="Ink field" wide>
          <div className="catalog-art" style={{ margin: 0, width: "100%" }}>
            <InkField />
          </div>
        </Demo>
      </GallerySection>

      <GallerySection
        id="colour"
        title="Colour"
        description="Ultramarine carries actions. Ink carries reading. Vermilion, yellow and pink belong to the art; semantic success and error colours stay separate."
      >
        <Demo name="Brand palette" wide surface={false}>
          <div className="swatch-grid">
            {Object.entries(brandColors).map(([name, value]) => (
              <div key={name}>
                <div className="swatch-block" style={{ background: value }} />
                <div className="swatch-name">{name}</div>
                <div className="swatch-hex">{value}</div>
              </div>
            ))}
          </div>
        </Demo>
      </GallerySection>

      <GallerySection
        id="typography"
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
