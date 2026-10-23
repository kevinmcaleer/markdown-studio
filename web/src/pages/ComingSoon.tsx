import { Link } from "../Link";
import type { SuiteApp } from "../suite";

export function ComingSoon({ app }: { app: SuiteApp }) {
  return (
    <section className="narrow">
      <h1>{app.name}</h1>
      <p className="muted">{app.description}</p>
      <p>
        {app.name} isn't built yet. Follow along in{" "}
        <a href={`https://github.com/kevinmcaleer/markdown-studio/issues/${app.epic}`}>epic #{app.epic}</a>.
      </p>
      <Link href="/">Back to the suite</Link>
    </section>
  );
}
