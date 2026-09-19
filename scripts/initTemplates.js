// The canonical starter templates `wizz init` scaffolds.
//
// Together they are the showcase landing page: the global design-token
// stylesheet (App.css, linked from the document shell exactly as the dev
// server and `wizz build` copy it), the reactive document head block, the
// persistent Counter and the animated terminal Card, and a `/home` page
// demonstrating the src/pages route convention. The templates are compile
// targets: initTemplates.test.js compiles each one for both targets and
// init.test.js serves the scaffolded project, so a language or generator
// change that would break new projects fails the suite before it can ship.

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <!-- Mobile devices must render at CSS-pixel width, or everything zooms out. -->
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <!-- Tints the mobile browser UI to match the page background. -->
  <meta name="theme-color" content="#0b0f14">
  <title>wizz.js App</title>
  <!-- Import the stylesheet App.css -->
  <link rel="stylesheet" href="./App.css">
</head>
<body>
  <div id="app"></div>

  <script type="module" src="/runtime/main.js"></script>
</body>
</html>
`;

const APP_CSS = `/*
 * Global design tokens and landing-page layout.
 * Solid colors only — no gradients. Amber accent on graphite.
 */
:root {
  color-scheme: dark;
  --wizz-bg: #0b0f14;
  --wizz-surface: #10161e;
  --wizz-border: #232d3a;
  --wizz-text: #e8edf4;
  --wizz-muted: #94a0b2;
  --wizz-accent: #facc15;
  --wizz-accent-strong: #fde047;
  --wizz-accent-ink: #1a1405;
}

html, body {
    margin: 0;
    padding: 0;
    background-color: var(--wizz-bg);
    color: var(--wizz-text);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto,
      "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
}

main {
    margin: 0;
    padding: 4.5rem 1.5rem;
    min-height: 100vh;
    min-height: 100dvh;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 2.25rem;
    background-color: var(--wizz-bg);
}

/* Divider between the copy/counter block and the card. Rendered as a
   pseudo-element so the markup stays untouched: a horizontal rule in the
   stacked (flex) layout, restyled to a vertical rule by the desktop grid.
   This base rule must stay BEFORE the desktop media query so its height
   override wins the cascade there. */
main::after {
    content: "";
    height: 1px;
    align-self: stretch;
    background-color: #ffffff;
}

/* Keep the card below the divider in the stacked layout (::after is generated
   last, so the card must sort after it). No effect on the desktop grid, where
   explicit placement wins. */
main > .card {
    order: 1;
}

/* Small screens: tighten the vertical rhythm now that content renders at
   CSS-pixel scale instead of a zoomed-out desktop viewport. */
@media (max-width: 640px) {
    main {
        padding: 3rem 1.25rem;
        gap: 1.75rem;
    }
}

/* Desktop: two-column hero — terminal card on the left, the badge, headline,
   and counter stacked on the right, with a vertical divider in its own 1px
   track between them. The fr column absorbs leftover width so the layout
   never overflows between the breakpoint and the max width. */
@media (min-width: 960px) {
    main {
        display: grid;
        grid-template-columns: minmax(0, 30rem) 1px minmax(0, 1fr);
        justify-content: center;
        align-content: center;
        column-gap: clamp(1.75rem, 3.5vw, 3rem);
        row-gap: 1.5rem;
        max-width: 76rem;
        margin: 0 auto;
        padding: 4.5rem 2.5rem;
    }

    main > .card {
        grid-column: 1;
        grid-row: 1 / span 3;
        align-self: center;
    }

    main > p {
        grid-column: 3;
        grid-row: 1;
        justify-self: start;
    }

    main > h1 {
        grid-column: 3;
        grid-row: 2;
        text-align: left;
    }

    /* The Counter's unclassed root div: pin it into the copy column and
       left-align its content to match the headline (this outranks the
       component's scoped div rule, which centers). */
    main > div:not(.card) {
        grid-column: 3;
        grid-row: 3;
        align-items: flex-start;
    }

    /* Vertical divider: the stretched pseudo-element spans all three copy
       rows, so it is exactly as tall as the badge + headline + counter
       block. height resets to auto so grid stretch (not the 1px mobile
       height) applies. */
    main::after {
        grid-column: 2;
        grid-row: 1 / span 3;
        height: auto;
    }
}

/* The subtitle is reordered above the headline and styled as a pill badge. */
main > p {
    order: -1;
    margin: 0;
    padding: 0.45rem 1.1rem;
    border: 1px solid rgba(250, 204, 21, 0.35);
    border-radius: 999px;
    color: var(--wizz-accent);
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    text-align: center;
}

h1 {
    margin: 0;
    max-width: 24ch;
    text-align: center;
    font-size: clamp(2.4rem, 6vw, 3.75rem);
    font-weight: 700;
    letter-spacing: -0.025em;
    line-height: 1.08;
    text-wrap: balance;
}

/* Base button — the Counter's scoped style refines this further. */
button {
    appearance: none;
    border: 0;
    border-radius: 999px;
    background-color: var(--wizz-accent);
    color: var(--wizz-accent-ink);
    cursor: pointer;
    font: inherit;
    font-weight: 700;
    letter-spacing: 0;
    padding: 0.8rem 1.6rem;
    transition: background-color 150ms ease, transform 150ms ease,
      box-shadow 150ms ease;
}

button:hover {
    background-color: var(--wizz-accent-strong);
    transform: translateY(-1px);
    box-shadow: 0 10px 28px -12px rgba(250, 204, 21, 0.55);
}

button:active {
    transform: translateY(0) scale(0.98);
    box-shadow: none;
}

button:focus-visible {
    outline: 2px solid var(--wizz-accent);
    outline-offset: 3px;
}

::selection {
    background-color: var(--wizz-accent);
    color: var(--wizz-accent-ink);
}
`;

const APP_WIZZ = `<script>
  import Counter from "./components/Counter.wizz";
  import Card from "./components/Card.wizz";
  const frameworkName = "wizz.js";

  let name = "friend";
  let description = "The zero-dependency compiled component framework";

  // The query string is only readable in the browser: keep the read behind a
  // lifecycle hook so the server render produces the "friend" default and the
  // reactivity engine applies the real value after hydration.
  onMount(() => {
    const params = new URLSearchParams(document.location.search);
    const visitor = params.get("name");
    if (visitor) {
      name = visitor;
      // Reactive head updates are out of scope: the meta keeps its
      // server-rendered description after hydration.
      description = "A greeting, customized";
    }
  });
</script>

<wizz:head>
  <title>Hello {name} - {frameworkName}</title>
  <meta name="description" content={description}>
</wizz:head>

<main>
  <h1>Hello {name} Welcome to {frameworkName}!</h1>
  <p>Zero dependencies. 100% compiled.</p>
  <Counter showReset={true} />
  <Card />
</main>
`;

const HOME_WIZZ = `<script>
  let title = "The Home page";
</script>

<wizz:head>
  <title>Home - wizz.js</title>
  <meta name="description" content="A page below /, server-rendered and hydrated">
</wizz:head>

<main>
  <section class="page">
    <h1>{title}</h1>
    <p>
      Files in <code>src/pages</code> get a route from their path. This one
      server-renders at <code>/home</code> and hydrates in the browser.
    </p>
    <p><a href="/">Back to the start page</a></p>
  </section>
</main>

<wizz:style>
  .page {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.25rem;
    max-width: 40rem;
  }
  h1 {
    margin: 0;
  }
  p {
    margin: 0;
    color: var(--wizz-muted);
    line-height: 1.6;
    text-align: center;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.9em;
    color: var(--wizz-accent);
  }
  a {
    color: var(--wizz-accent);
    font-weight: 600;
    text-decoration-color: rgba(250, 204, 21, 0.4);
    text-underline-offset: 3px;
    transition: text-decoration-color 150ms ease;
  }
  a:hover {
    text-decoration-color: var(--wizz-accent);
  }
</wizz:style>
`;

const COUNTER_WIZZ = `<script>
  let count = persist('count', 0);
  let rawClicks = 0;

  export let showReset = false;

  function increment() {
    count += 1;
    rawClicks += 1;
  }

  function reset() {
    count = 0;
    rawClicks = 0;
  }
</script>

<div>
  <button on:click={increment}>Increment Counter</button>
  <p>Clicks: {rawClicks}. Persisted clicks: {count} {#if showReset}<span class="reset" on:click={reset}>Reset</span>{/if}</p>
</div>

<wizz:style>
  div {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }
  button {
    appearance: none;
    margin: 0;
    border: 0;
    border-radius: 999px;
    background-color: var(--wizz-accent);
    color: var(--wizz-accent-ink);
    cursor: pointer;
    font: inherit;
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: 0;
    padding: 0.8rem 1.6rem;
    transition: background-color 150ms ease, transform 150ms ease,
      box-shadow 150ms ease;
  }
  button:hover {
    background-color: var(--wizz-accent-strong);
    transform: translateY(-1px);
    box-shadow: 0 10px 28px -12px rgba(250, 204, 21, 0.55);
  }
  button:active {
    transform: translateY(0) scale(0.98);
    box-shadow: none;
  }
  button:focus-visible {
    outline: 2px solid var(--wizz-accent);
    outline-offset: 3px;
  }
  p {
    margin: 0;
    color: var(--wizz-muted);
    font-size: 0.95rem;
    letter-spacing: 0.01em;
    text-transform: none;
    font-variant-numeric: tabular-nums;
  }
  .reset {
    cursor: pointer;
    margin-left: 0.25rem;
    color: var(--wizz-accent);
    font-weight: 600;
    text-decoration: underline;
    text-decoration-color: rgba(250, 204, 21, 0.4);
    text-underline-offset: 3px;
    transition: color 150ms ease, text-decoration-color 150ms ease;
  }
  .reset:hover {
    text-decoration-color: var(--wizz-accent);
  }
</wizz:style>
`;

const CARD_WIZZ = `<div class="card">
  <div class="wrap">
    <div class="terminal">
      <hgroup class="head">
        <p class="title">
          <svg
            width="16px"
            height="16px"
            aria-hidden="true"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            stroke-linejoin="round"
            stroke-linecap="round"
            stroke-width="2"
            stroke="currentColor"
            fill="none"
          >
            <path
              d="M7 15L10 12L7 9M13 15H17M7.8 21H16.2C17.8802 21 18.7202 21 19.362 20.673C19.9265 20.3854 20.3854 19.9265 20.673 19.362C21 18.7202 21 17.8802 21 16.2V7.8C21 6.11984 21 5.27976 20.673 4.63803C20.3854 4.07354 19.9265 3.6146 19.362 3.32698C18.7202 3 17.8802 3 16.2 3H7.8C6.11984 3 5.27976 3 4.63803 3.32698C4.07354 3.6146 3.6146 4.07354 3.32698 4.63803C3 5.27976 3 6.11984 3 7.8V16.2C3 17.8802 3 18.7202 3.32698 19.362C3.6146 19.9265 4.07354 20.3854 4.63803 20.673C5.27976 21 6.11984 21 7.8 21Z"
            ></path>
          </svg>
          Terminal
        </p>
      </hgroup>

      <div class="body">
        <pre class="pre">
          <code>- </code>
          <code>wizz </code>
          <code class="cmd" data-cmd="build src dist"></code>
        </pre>
      </div>
    </div>
  </div>
</div>


<wizz:style>
  .card {
    width: min(480px, 100%);
    padding: 10px;
    overflow: hidden;
    border: 1px solid var(--wizz-border);
    border-radius: 18px;
    background-color: var(--wizz-surface);
    box-shadow: 0 24px 60px -28px rgba(0, 0, 0, 0.65);
  }
  .wrap {
    display: flex;
    flex-direction: column;
    position: relative;
    z-index: 10;
    border: 1px solid var(--wizz-border);
    border-radius: 10px;
    overflow: hidden;
  }
  .terminal {
    display: flex;
    flex-direction: column;

    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
      "Liberation Mono", "Courier New", monospace;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    overflow: hidden;
    min-height: 44px;
    padding-inline: 14px;
    background-color: #171e28;
  }
  .head::before {
    content: "";
    flex: none;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background-color: #ff5f57;
    box-shadow: 19px 0 0 #febc2e, 38px 0 0 #29c73f;
    margin-right: 60px;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 0;
    user-select: none;
    font-size: 0.85rem;
    font-weight: 500;
    letter-spacing: 0.02em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--wizz-muted);
  }
  .title > svg {
    height: 15px;
    width: 15px;
    color: var(--wizz-accent);
  }
  .body {
    display: flex;
    flex-direction: column;
    position: relative;
    overflow-x: auto;
    padding: 1.25rem;
    line-height: 19px;
    color: #d8dee8;
    background-color: #0a0e14;
    white-space: nowrap;
  }
  .pre {
    display: flex;
    flex-direction: row;
    align-items: center;
    text-wrap: nowrap;
    white-space: pre;
    background-color: transparent;
    overflow: hidden;
    box-sizing: border-box;
    font-size: 16px;
  }
  .pre code:nth-child(1) {
    color: #4d5766;
  }
  .pre code:nth-child(2) {
    color: var(--wizz-accent);
  }
  .cmd {
    height: 19px;
    position: relative;
    display: flex;
    align-items: center;
    flex-direction: row;
  }
  .cmd::before {
    content: attr(data-cmd);
    position: relative;
    display: block;
    white-space: nowrap;
    overflow: hidden;
    background-color: transparent;
    animation: inputs 8s steps(22) infinite;
  }
  .cmd::after {
    content: "";
    position: relative;
    display: block;
    height: 100%;
    overflow: hidden;
    background-color: transparent;
    border-right: 0.15em solid var(--wizz-accent);
    animation: cursor 0.5s step-end infinite alternate, blinking 0.5s infinite;
  }

  @keyframes blinking {
    20%,
    80% {
      transform: scaleY(1);
    }
    50% {
      transform: scaleY(0);
    }
  }
  @keyframes cursor {
    50% {
      border-right-color: transparent;
    }
  }
  @keyframes inputs {
    0%,
    100% {
      width: 0;
    }
    10%,
    90% {
      width: 58px;
    }
    30%,
    70% {
      width: 215px;
      max-width: max-content;
    }
  }
</wizz:style>
`;

// Insertion order is the scaffold order init reports.
module.exports = {
  'index.html': INDEX_HTML,
  'App.css': APP_CSS,
  'src/App.wizz': APP_WIZZ,
  'src/pages/Home.wizz': HOME_WIZZ,
  'src/components/Counter.wizz': COUNTER_WIZZ,
  'src/components/Card.wizz': CARD_WIZZ
};
