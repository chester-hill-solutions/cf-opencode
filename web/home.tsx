import type { ReactNode } from "react"
import { ArrowDown, ArrowRight, Check, GitBranch, MessageSquare, ShieldCheck } from "lucide-react"
import { LinkButton, Logo, Status } from "@aboiteau/ui"
import { SiteFooter, SiteHeader } from "./shared/site-header"

/** One agent turn in the illustrative thread; the avatar and name never vary. */
function StoryAgent({ children }: { children: ReactNode }) {
  return (
    <div className="story-person">
      <span className="story-avatar agent">
        <Logo variant="mono" />
      </span>
      <div>
        <strong>Aboiteau</strong>
        {children}
      </div>
    </div>
  )
}

export function MarketingPage() {
  return (
    <>
      <SiteHeader page="home" />
      <main id="main" className="marketing-main">
        <section className="marketing-hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow">Aboiteau / Your coding agent, connected</p>
            <h1 id="hero-title">
              Good work
              <br />
              deserves
              <br />
              <span>continuity.</span>
            </h1>
            <p className="hero-lead">
              Give your coding agent a workspace it can come back to. Pick a repository, connect
              your model, and keep the conversation going in Slack.
            </p>
            <div className="hero-actions">
              <LinkButton href="/onboarding/" size="touch">
                Set up your workspace <ArrowRight aria-hidden="true" />
              </LinkButton>
              <a className="text-link" href="#how-it-works">
                See how it works <ArrowDown size={16} aria-hidden="true" />
              </a>
            </div>
            <p className="hero-note">Built on OpenCode. Runs on your Cloudflare deployment.</p>
          </div>
          <div
            className="hero-story"
            aria-label="Illustrative conversation showing how a persistent workspace works"
          >
            <div className="story-caption">
              <span>One conversation. A workspace that stays.</span>
              <span>Illustrative example</span>
            </div>
            <div className="story-thread">
              <div className="story-person">
                <span className="story-avatar">Y</span>
                <div>
                  <strong>You</strong>
                  <p>Find out why the build is failing on this branch.</p>
                </div>
              </div>
              <StoryAgent>
                <p>I’ll inspect the repository and check the failing build.</p>
              </StoryAgent>
              <div className="story-tools">
                <span>
                  <GitBranch size={15} aria-hidden="true" /> Workspace restored
                </span>
                <span>
                  <Check size={15} aria-hidden="true" /> Repository inspected
                </span>
                <span>
                  <Check size={15} aria-hidden="true" /> Build output reviewed
                </span>
              </div>
              <StoryAgent>
                <p>
                  The build expects a variable that isn’t set in this environment. Here’s where
                  it’s read, and what to update.
                </p>
                <Status tone="success">Turn complete</Status>
              </StoryAgent>
            </div>
            <div className="story-continuation">
              <MessageSquare size={19} aria-hidden="true" />
              <div>
                <strong>Pick up where you left off.</strong>
                <p>The next message continues with the same workspace.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="marketing-principles" aria-label="What stays connected">
          <p>
            <GitBranch aria-hidden="true" />
            <strong>Your repository</strong>
            <span>Real files. A persistent workspace.</span>
          </p>
          <p>
            <MessageSquare aria-hidden="true" />
            <strong>Your conversation</strong>
            <span>Continue in a Slack thread or over the API.</span>
          </p>
          <p>
            <ShieldCheck aria-hidden="true" />
            <strong>Your rules</strong>
            <span>Choose models, permissions and limits.</span>
          </p>
        </section>

        <section
          id="how-it-works"
          className="marketing-section workflow-section"
          aria-labelledby="workflow-title"
        >
          <div className="marketing-section-intro">
            <p className="eyebrow">From a question to a working context</p>
            <h2 id="workflow-title">
              Less starting over.
              <br />
              More moving forward.
            </h2>
            <p>
              Aboiteau brings the repository, model connection and conversation together. You decide
              where the work begins.
            </p>
          </div>
          <ol className="workflow-steps">
            <li data-accent="ultramarine">
              <span className="section-number">01</span>
              <div>
                <h3>Bring a repository or start fresh</h3>
                <p>
                  Start general work, or bind a repository and branch per conversation. Connect
                  GitHub when the repository is private.
                </p>
              </div>
            </li>
            <li data-accent="vermilion">
              <span className="section-number">02</span>
              <div>
                <h3>Connect your model</h3>
                <p>
                  Use a provider API key or an available sign-in method. Choose from the connected
                  provider’s live model catalogue.
                </p>
              </div>
            </li>
            <li data-accent="yellow">
              <span className="section-number">03</span>
              <div>
                <h3>Start a conversation</h3>
                <p>
                  With the Slack adapter configured, mention Aboiteau in a thread or send a DM. HTTP
                  and streaming events are available too.
                </p>
              </div>
            </li>
          </ol>
        </section>

        <section className="control-section" aria-labelledby="control-title">
          <div>
            <p className="eyebrow">A clear working agreement</p>
            <h2 id="control-title">
              Give it room.
              <br />
              Keep your say.
            </h2>
            <p>
              Set the boundaries before the first task. See reported usage and reserved amounts as
              work progresses.
            </p>
            <LinkButton href="/settings/" variant="outline">
              Explore settings <ArrowRight aria-hidden="true" />
            </LinkButton>
          </div>
          <dl className="control-list">
            <div data-accent="ultramarine">
              <dt>Choose the model</dt>
              <dd>A provider and model that fit the work.</dd>
            </div>
            <div data-accent="vermilion">
              <dt>Decide what needs approval</dt>
              <dd>Allow, ask and deny rules for shell commands.</dd>
            </div>
            <div data-accent="yellow">
              <dt>Set an admission budget</dt>
              <dd>Gate new turns with a daily budget. An already running turn can exceed it.</dd>
            </div>
            <div data-accent="pink">
              <dt>Keep track of the workspace</dt>
              <dd>Inspect reported spend, reservations and known conversations.</dd>
            </div>
          </dl>
        </section>

        <section className="marketing-section marketing-start" aria-labelledby="start-title">
          <p className="eyebrow">Ready for the next conversation</p>
          <h2 id="start-title">
            Make a little room
            <br />
            for what’s next.
          </h2>
          <p>
            Already have an Aboiteau deployment? Connect your provider and repository to get
            started.
          </p>
          <LinkButton href="/onboarding/" size="touch">
            Set up Aboiteau <ArrowRight aria-hidden="true" />
          </LinkButton>
          <a
            className="text-link"
            href="https://github.com/chester-hill-solutions/cf-opencode#readme"
          >
            Deploying it yourself? Read the setup guide ↗
          </a>
        </section>
      </main>
      <SiteFooter />
    </>
  )
}
