// Inline CSS for the loopback status dashboard. Self-contained so the
// dashboard ships as a single binary with no static assets to serve.
export const STYLES = `
:root{
  --canvas:#eeefe9;--surface-soft:#e5e7e0;--surface-card:#ffffff;--surface-doc:#fcfcfa;
  --surface-dark:#23251d;--hairline:#bfc1b7;--hairline-soft:#dcdfd2;--on-dark:#ffffff;
  --primary:#f7a501;--primary-pressed:#dd9001;--on-primary:#23251d;
  --ink:#23251d;--body:#4d4f46;--charcoal:#33342d;--mute:#6c6e63;--ash:#9b9c92;
  --link-teal:#1078a3;
  --accent-blue:#2c84e0;--accent-blue-soft:#dceaf6;
  --accent-red:#cd4239;--accent-red-soft:#f7d6d3;
  --accent-green:#2c8c66;--accent-green-soft:#d9eddf;
  --accent-purple:#7c44a6;--accent-purple-soft:#e7d8ee;
}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--canvas);color:var(--body);
  font-family:'IBM Plex Sans','IBM Plex Sans Variable',-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
  font-size:16px;line-height:1.5;font-weight:400;
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;
}
a{color:var(--link-teal);text-decoration:none}
a:hover,a:focus{text-decoration:underline}

/* nav */
.nav{
  display:flex;align-items:center;gap:12px;
  height:56px;padding:0 24px;border-bottom:1px solid var(--hairline);
  background:var(--canvas);
}
.wordmark{
  display:flex;align-items:center;gap:8px;
  font-weight:700;font-size:16px;color:var(--ink);letter-spacing:0;
}
.wordmark .mascot{width:22px;height:22px;display:block}
.eyebrow-pill{
  margin-left:4px;padding:4px 10px;border-radius:9999px;
  background:var(--surface-soft);color:var(--body);
  font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0;
}
.nav-spacer{flex:1}
.nav-meta{font-size:13px;color:var(--mute)}

/* container */
.container{max-width:1100px;margin:0 auto;padding:48px 24px 24px}
.section{margin-top:64px}
.section-tight{margin-top:24px}

/* type */
.eyebrow{
  font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0;
  color:var(--mute);margin:0 0 12px;
}
.display{
  font-size:36px;font-weight:800;line-height:1.2;letter-spacing:0;
  color:var(--ink);margin:0 0 16px;
}
.h2{
  font-size:21px;font-weight:700;line-height:1.4;letter-spacing:0;
  color:var(--ink);margin:0 0 16px;
}
.heading-link{
  display:inline-flex;align-items:center;justify-content:center;
  width:24px;height:24px;margin-left:4px;vertical-align:-4px;
  color:var(--mute);border-radius:4px;text-decoration:none;
}
.heading-link:hover,.heading-link:focus{color:var(--link-teal);text-decoration:none}
.lede{font-size:16px;color:var(--body);margin:0;max-width:720px}
.mute{color:var(--mute)}
.num{font-variant-numeric:tabular-nums}

/* cards */
.card{
  background:var(--surface-card);border:1px solid var(--hairline);
  border-radius:6px;padding:24px;
}
.card + .card{margin-top:16px}
.card .block + .block{margin-top:24px}

/* stats grid */
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:16px}
.stats-dashboard{grid-template-columns:repeat(4,1fr)}
.stat{
  background:var(--surface-card);border:1px solid var(--hairline);
  border-radius:6px;padding:20px 24px;
}
.stat-label{
  font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0;
  color:var(--mute);margin:0 0 8px;
}
.stat-value{
  font-size:28px;font-weight:800;letter-spacing:0;
  color:var(--ink);margin:0;font-variant-numeric:tabular-nums;
}
.stat-value-sm{font-size:18px}
.stat-detail{font-size:13px;color:var(--mute);margin:6px 0 0}

/* tables */
.table-card{
  background:var(--surface-card);border:1px solid var(--hairline);
  border-radius:6px;overflow:hidden;
}
.table-note{font-size:13px;color:var(--mute);margin:12px 0 0}
.table-scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:14px}
thead th{
  text-align:left;padding:14px 12px;
  font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0;
  color:var(--mute);background:var(--surface-card);
  border-bottom:1px solid var(--hairline);white-space:nowrap;
}
tbody td{
  padding:14px 12px;border-bottom:1px solid var(--hairline-soft);
  color:var(--body);vertical-align:middle;
}
tbody tr:last-child td{border-bottom:none}
th:first-child,td:first-child{padding-left:24px}
th:last-child,td:last-child{padding-right:24px}
.col-num{text-align:right;font-variant-numeric:tabular-nums}
.col-when{color:var(--mute);white-space:nowrap;font-variant-numeric:tabular-nums}
.col-author{color:var(--charcoal);font-weight:600;white-space:nowrap}
.col-reason{color:var(--mute);max-width:360px;word-break:break-word}
.author-link{color:var(--charcoal);font-weight:600;text-decoration:none}
.author-link:hover{color:var(--link-teal);text-decoration:underline}
.ticker-link{font-weight:700;color:var(--ink)}
.ticker-link:hover{color:var(--link-teal)}
.empty{padding:48px 24px;color:var(--ash);font-size:14px;text-align:center}

/* pager */
.pager{
  display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:12px 24px;border-top:1px solid var(--hairline);
  background:var(--surface-card);font-size:13px;color:var(--mute);
  font-variant-numeric:tabular-nums;
}
.pager-nav{display:inline-flex;gap:8px}
.pager-link{
  display:inline-block;padding:6px 12px;border-radius:6px;
  border:1px solid var(--hairline);background:var(--surface-card);
  color:var(--ink);font-weight:600;text-decoration:none;
}
.pager-link:hover,.pager-link:focus{background:var(--surface-soft);text-decoration:none}
.pager-link-disabled{color:var(--ash);background:var(--surface-soft);cursor:not-allowed}
.pager-link-disabled:hover{background:var(--surface-soft)}

/* pills */
.pill{
  display:inline-block;padding:3px 10px;border-radius:9999px;
  font-size:12px;font-weight:600;letter-spacing:0;white-space:nowrap;
}
.pill-launched{background:var(--accent-green-soft);color:var(--accent-green)}
.pill-dry-run{background:var(--accent-purple-soft);color:var(--accent-purple)}
.pill-low{background:var(--surface-soft);color:var(--mute)}
.pill-validation{background:var(--accent-blue-soft);color:var(--accent-blue)}
.pill-safety,.pill-error{background:var(--accent-red-soft);color:var(--accent-red)}

/* code */
code,.code-inline{
  font-family:ui-monospace,'Source Code Pro',SFMono-Regular,Menlo,monospace;
  font-size:13px;background:var(--surface-soft);color:var(--ink);
  padding:2px 6px;border-radius:2px;
}
.code-block{
  margin:0;background:var(--surface-dark);color:var(--on-dark);
  border-radius:6px;padding:16px 20px;
  font-family:ui-monospace,'Source Code Pro',SFMono-Regular,Menlo,monospace;
  font-size:13px;line-height:1.5;overflow-x:auto;
  word-break:break-all;white-space:pre-wrap;
}
.code-block-with-link{
  display:flex;align-items:center;gap:12px;
  padding-right:14px;
}
.code-block-with-link .code-text{flex:1;min-width:0;word-break:break-all;white-space:pre-wrap}
.code-link-inline{
  display:inline-flex;align-items:center;justify-content:center;
  flex:0 0 auto;width:24px;height:24px;
  color:var(--on-dark);opacity:0.55;
  text-decoration:none;border-radius:4px;
  transition:opacity 0.15s;
}
.code-link-inline:hover,.code-link-inline:focus{opacity:1;text-decoration:none}

/* token avatar */
.token-avatar{
  width:40px;height:40px;border-radius:9999px;
  object-fit:cover;background:var(--surface-soft);
  vertical-align:-8px;margin-right:12px;
  border:1px solid var(--hairline);
}

/* banners */
.banner{
  border-radius:6px;padding:16px 20px;font-size:15px;line-height:1.6;
  color:var(--ink);margin:0;
}
.banner + .banner{margin-top:12px}
.banner-tip{background:var(--accent-blue-soft)}
.banner-success{background:var(--accent-green-soft)}
.banner-warn{background:var(--accent-red-soft)}
.banner-note{background:var(--accent-purple-soft)}
.banner-icon{font-weight:700;margin-right:6px}
.banner-label{font-weight:700;margin-right:4px}

/* buttons */
.btn-primary{
  display:inline-flex;align-items:center;gap:6px;
  padding:8px 16px;border-radius:6px;border:none;cursor:pointer;
  background:var(--primary);color:var(--on-primary);
  font-family:inherit;font-size:14px;font-weight:700;line-height:1.5;
  text-decoration:none;
}
.btn-primary:hover{background:var(--primary-pressed);text-decoration:none}
.btn-tertiary{
  display:inline-block;padding:8px 0;
  color:var(--ink);font-size:14px;font-weight:700;
}
.btn-tertiary:hover{color:var(--link-teal)}

/* footer */
.footer{
  border-top:1px solid var(--hairline);
  padding:32px 24px;margin-top:64px;
  font-size:13px;color:var(--mute);text-align:center;
}
.footer .mascot{width:16px;height:16px;vertical-align:-3px;margin-right:4px}

/* responsive */
@media (max-width:768px){
  .container{padding:32px 16px 16px}
  .section{margin-top:48px}
  .nav{padding:0 16px}
  .nav-meta{display:none}
  .display{font-size:28px}
  .stats,.stats-dashboard{grid-template-columns:1fr}
  .col-reason{max-width:none}
}
`;
