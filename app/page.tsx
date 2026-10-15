const repository = "https://github.com/Must-be-Ash/eve-trading-agent-template";

export default function Home() {
  return (
    <main className="home">
      <header className="masthead">
        <a className="wordmark" href="/">eve<span> / trading</span></a>
        <a className="source-link" href={repository}>Source ↗</a>
      </header>
      <section className="hero">
        <div>
          <p className="eyebrow">Photon · Coinbase · Eve</p>
          <h1>Your market.<br />Your message.<br /><em>Your decision.</em></h1>
          <p className="intro">Research markets, follow X accounts in separate sessions, and prepare spot trades from iMessage. Review the exact order before anything moves.</p>
          <a className="button" href={`${repository}#setup`}>Set up your agent <span>↗</span></a>
          <p className="caption">A starter you deploy with your own accounts.</p>
        </div>
        <div className="conversation" aria-label="Illustrative conversation, not live market data">
          <div className="conversation-header"><span className="status-dot" /> Your trading assistant <span className="example">Example</span></div>
          <p className="bubble sent">Show me the BTC-USD market, then prepare a $25 market buy.</p>
          <p className="bubble received">I’ll check the market and preview the order for your review.</p>
          <div className="order-card">
            <p className="eyebrow">Order preview</p>
            <div className="order-heading"><strong>Buy BTC</strong><span>Market</span></div>
            <dl><div><dt>Product</dt><dd>BTC-USD</dd></div><div><dt>Quote size</dt><dd>$25.00</dd></div></dl>
            <p>Review current fees and terms in the approval card. Nothing is submitted until you approve.</p>
            <div className="example-actions" aria-hidden="true"><span>Deny</span><span>Approve</span></div>
          </div>
          <p className="example-note">Illustration only. These controls do not place a trade.</p>
        </div>
      </section>
      <section className="features" aria-label="Included capabilities">
        <article><span className="feature-number">01</span><h2>Text naturally</h2><p>One owner, multiple isolated conversations. Background agents and alerts return to the right session.</p></article>
        <article><span className="feature-number">02</span><h2>Approve precisely</h2><p>Spot orders and cancellations with explicit approvals, expiry, and replay protection.</p></article>
        <article><span className="feature-number">03</span><h2>Share the research</h2><p>Scheduled X research, public reports, charts, and media. Private account information stays in chat.</p></article>
      </section>
      <footer><span>Built with <a href="https://eve.dev">eve</a></span><a href={`${repository}/blob/main/docs/submission.md`}>Template notes ↗</a></footer>
    </main>
  );
}
