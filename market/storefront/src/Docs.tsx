// The docs: two parts for someone who uses covibe. Part 1 gets a team running
// on their own work; part 2 puts that team on the market. Static, like the start page.
import { useEffect, type ReactNode } from 'react';

const REPO = 'https://github.com/Pizajolo/covibe';

interface Entry {
  id: string;
  title: string;
}

const PART_1: Entry[] = [
  { id: 'install', title: 'Install covibe' },
  { id: 'accounts', title: 'Connect your accounts' },
  { id: 'skills', title: 'Add skills' },
  { id: 'plugins', title: 'Add plugins and MCP servers' },
  { id: 'team', title: 'Create a team' },
  { id: 'run', title: 'Run your first goal' },
  { id: 'run-risks', title: 'Risks when running a team' },
];

const PART_2: Entry[] = [
  { id: 'sell-need', title: 'What you need' },
  { id: 'sell-connect', title: 'Connect covibe to the market' },
  { id: 'storefront', title: 'Create a storefront' },
  { id: 'publish', title: 'Publish and take orders' },
  { id: 'payment', title: 'Delivery and payment' },
  { id: 'sell-risks', title: 'Risks when selling' },
];

function Risk({ title = 'Risk', children }: { title?: string; children: ReactNode }) {
  return (
    <aside className="doc-risk">
      <strong>{title}</strong>
      <div>{children}</div>
    </aside>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="lp-code">
      <code>{children}</code>
    </pre>
  );
}

function Toc({ label, entries, current }: { label: string; entries: Entry[]; current?: string }) {
  return (
    <>
      <strong>{label}</strong>
      <ul>
        {entries.map((e) => (
          <li key={e.id}>
            <a href={`#/docs/${e.id}`} className={current === e.id ? 'on' : ''}>
              {e.title}
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}

export function Docs({ section }: { section?: string }) {
  useEffect(() => {
    if (section) document.getElementById(section)?.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [section]);

  return (
    <div className="doc">
      <nav className="doc-toc" aria-label="Docs contents">
        <Toc label="Part 1: Run a team" entries={PART_1} current={section} />
        <Toc label="Part 2: Sell on the market" entries={PART_2} current={section} />
      </nav>

      <article className="doc-body">
        <h1>covibe docs</h1>
        <p className="doc-lede">
          Two parts. The first gets a team of AI agents working on your own project. The second puts that team on the market so other people can order from it. Each part ends with the risks you should know before you rely on it.
        </p>
        <p>
          Only ordering from a team? You do not need covibe or these docs: <a href="#/">see how an order works</a>.
        </p>

        <h2 className="doc-part">Part 1: Run a team on your own work</h2>

        <section id="install">
          <h3>Install covibe</h3>
          <p>You need a Mac, Node 22.13 or newer, git, and Claude Code signed in. To sign in to Claude Code, run this once in Terminal:</p>
          <Code>claude login</Code>
          <p>
            Then <a href="#/download">download covibe</a> and move it to Applications. The app is not code-signed yet, so the first time you open it, right-click covibe and choose Open.
          </p>
          <p>To build it yourself instead:</p>
          <Code>{`git clone ${REPO}.git
cd covibe
npm install        # builds the engine and the app
npm run desktop    # opens covibe in a window`}</Code>
          <p>
            For the command line, run <code>npm run build &amp;&amp; npm link</code> in the same folder. That puts <code>covibe</code> on your PATH. The app and the command line use the same teams, settings and run history.
          </p>
        </section>

        <section id="accounts">
          <h3>Connect your accounts</h3>
          <p>
            With <code>claude login</code> done, covibe already works on your Claude subscription. Everything else is under <strong>Settings → Advanced</strong>:
          </p>
          <dl className="doc-defs">
            <dt>More Claude accounts</dt>
            <dd>Add an account and covibe opens Terminal with Claude's own sign-in for it. The login never passes through covibe. You then choose the account per team or per member.</dd>
            <dt>ChatGPT accounts</dt>
            <dd>Add an account and your browser opens OpenAI's sign-in page. Members on it use OpenAI's models within your ChatGPT plan.</dd>
            <dt>Model providers</dt>
            <dd>
              Add a provider with its address, API key and models: DeepSeek, Moonshot, Z.ai, Alibaba Cloud, OpenAI, OpenRouter, Groq, a local Ollama, or any Anthropic- or OpenAI-compatible API. Its models then appear in every team's model list.
            </dd>
          </dl>
          <p>
            Keys are saved in the macOS Keychain, never in a team file. Members do not see them. On the command line, <code>covibe connections</code> lists what is set up and <code>covibe login &lt;account&gt;</code> signs one in.
          </p>
          <Risk title="Check the terms of each plan">
            <p>
              A Claude or ChatGPT subscription is meant for your own work on your own machine. Using several accounts to get around usage limits, or using a plan outside the provider's own apps, may not be allowed. Read the provider's current terms before you rely on either.
            </p>
          </Risk>
          <Risk title="Other models behave differently">
            <p>Models other than Claude are less predictable with long, tool-heavy work, and some cannot read images. Try a new provider on a low-risk member first, such as a reviewer.</p>
          </Risk>
        </section>

        <section id="skills">
          <h3>Add skills</h3>
          <p>
            A skill is a set of instructions, with any files it needs, that a member loads when a task calls for it. The <strong>Skills</strong> page is one library for all your teams. You can:
          </p>
          <ul>
            <li>write your own,</li>
            <li>add one from GitHub, from a repository or a folder in it,</li>
            <li>install from Anthropic's skills.</li>
          </ul>
          <p>
            Give a skill to one member, to every member of a team, or mark it <strong>Everyone</strong> to give it to all members of all teams. A member sees only the skills you gave it.
          </p>
        </section>

        <section id="plugins">
          <h3>Add plugins and MCP servers</h3>
          <p>
            Plugins give members more to work with: commands, hooks, and MCP servers that connect them to a service such as Notion, Linear or ElevenLabs. On the <strong>Plugins</strong> page, install from Anthropic's directory or from any GitHub repository.
          </p>
          <p>
            To connect a single MCP server, choose <strong>Add MCP server</strong> and paste whatever the service publishes:
          </p>
          <ul>
            <li>
              an address, such as <code>https://mcp.example.com/mcp</code>
            </li>
            <li>
              a command, such as <code>npx -y @example/mcp-server</code>
            </li>
            <li>a JSON snippet written for Claude Code, Claude Desktop, Cursor or VS Code</li>
          </ul>
          <p>
            Before anything is installed, covibe shows what the plugin runs on your computer and where it sends data. You choose its sandbox: which websites it may reach and which folders it may write. A server that runs on your Mac can reach no website until you allow one, so add the address of the service it talks to.
          </p>
          <p>
            If a server needs an API key, save it in the <strong>Keys and settings</strong> card on the plugin's page. If it needs your account, use the <strong>Sign in</strong> button there, or <code>covibe login &lt;plugin&gt;</code>. Then give the plugin to members, the same way as a skill.
          </p>
          <Risk title="Plugins run programs on your Mac">
            <p>
              covibe confines them to the sandbox you approve, and an update that changes what a plugin runs waits for your approval. But whatever a member sends to a remote server leaves your computer. Install only plugins whose source you trust, and allow only the websites and folders they need.
            </p>
          </Risk>
        </section>

        <section id="team">
          <h3>Create a team</h3>
          <p>
            On the <strong>Teams</strong> page, start in one of two ways:
          </p>
          <ul>
            <li>
              <strong>From a template:</strong> feature team, builder and reviewer, single assistant, writing, video editing, or research.
            </li>
            <li>
              <strong>With chat:</strong> describe the team you need. An architect agent reads your project and sets the team up. Keep talking to change it: "add a security reviewer", "use haiku for the tester".
            </li>
          </ul>
          <p>Then shape it in the editor:</p>
          <dl className="doc-defs">
            <dt>Members</dt>
            <dd>Each member's role prompt, model, tools, the paths it may change, who it can message, and its skills and plugins.</dd>
            <dt>Workflow</dt>
            <dd>The steps in order, who works on each, and the checks (gates) between them. Set where failed work goes back to and how many fix rounds it gets before the run comes to you.</dd>
            <dt>Team settings</dt>
            <dd>The connection, the sandbox, and limits on turns, time and spend.</dd>
          </dl>
          <p>
            The team is saved as one file, <code>team.yaml</code>, which you can also edit by hand. Check it with <code>covibe validate team.yaml</code>.
          </p>
        </section>

        <section id="run">
          <h3>Run your first goal</h3>
          <ol>
            <li>
              Choose <strong>New project</strong> and say where the work is: a folder on your Mac, a repository to clone, or a new project.
            </li>
            <li>Pick the team.</li>
            <li>Write the first goal and start the run.</li>
          </ol>
          <p>
            The run page shows every member, what it is doing, and each check as it passes or fails. You can chat with a member while it works. In a git repository your checkout is never touched: the result lands on its own branch, and when the run succeeds covibe asks whether to merge it, open a pull request, or just push the branch.
          </p>
          <p>From the command line:</p>
          <Code>{`cd ~/code/my-app
covibe run team.yaml --goal "Add a /health endpoint"`}</Code>
        </section>

        <section id="run-risks">
          <h3>Risks when running a team</h3>
          <Risk title="Usage and cost">
            <p>
              Several members working at once use up a plan's limits quickly, and on an API key they cost money per token. Keep the number of members working in parallel at two or three, and set a spend limit on teams that run on API keys.
            </p>
          </Risk>
          <Risk title="The sandbox is your safety net">
            <p>
              Shell commands run in a sandbox that limits what a member can write and which websites it can reach. Turning it off for a member gives that member your full permissions. Do it only for members you would trust with the goal unattended.
            </p>
          </Risk>
          <Risk title="Secrets">
            <p>Members read the project they work on. Keep passwords and keys out of the project folder and out of goals and chat messages.</p>
          </Risk>
          <Risk title="Review the result">
            <p>Passing checks means the team's own checks passed, not that the work is right. Read the changes before you merge or ship them.</p>
          </Risk>
        </section>

        <h2 className="doc-part">Part 2: Sell your team's work on the market</h2>
        <p>
          A storefront lets other people order from one of your teams. The customer pays into an escrow contract on NEAR; you are paid only when the checks you named pass and the customer confirms, or their review window ends. The market runs on NEAR testnet for now, with test NEAR.
        </p>

        <section id="sell-need">
          <h3>What you need</h3>
          <ul>
            <li>A team that reliably does one kind of job, with at least one check on its result.</li>
            <li>A NEAR account and its key. On testnet, create one in a testnet wallet or with near-cli-rs.</li>
            <li>
              The market's contract account. To try it end to end with your own contract and relay, follow <a href={`${REPO}#run-the-demo-on-testnet`}>the testnet demo in the README</a>.
            </li>
            <li>A model connection you are allowed to use for customers' work. See the first risk below.</li>
          </ul>
        </section>

        <section id="sell-connect">
          <h3>Connect covibe to the market</h3>
          <p>
            In the app, open <strong>Market → Settings</strong> and enter the contract, your NEAR account and its key. From the command line:
          </p>
          <Code>{`covibe market config --contract my-market.testnet --account my-account.testnet \\
  --key-file ~/.near-credentials/testnet/my-account.testnet.json`}</Code>
          <p>The key is saved in the macOS Keychain. covibe uses it to accept, decline and deliver orders, and to sign receipts.</p>
        </section>

        <section id="storefront">
          <h3>Create a storefront</h3>
          <p>
            Open <strong>Market → Storefronts</strong> and choose <strong>New storefront</strong>, then the team. The editor is a form next to an assistant: a chat with an agent that reads the team and fills the storefront in for you. You set:
          </p>
          <dl className="doc-defs">
            <dt>The page</dt>
            <dd>Title, summary, and examples of the team's work as pictures or videos.</dd>
            <dt>The order form</dt>
            <dd>The questions a customer answers: text fields and file uploads, with the file types and sizes you accept.</dd>
            <dt>The price and the windows</dt>
            <dd>The price in NEAR, and how long you have to accept, how long to deliver, and how long the customer has to review.</dd>
            <dt>What is delivered</dt>
            <dd>The folder the team puts its result in, and the checks that must pass before anything is delivered.</dd>
            <dt>Revisions</dt>
            <dd>
              How many revisions per order the team does automatically when a customer asks, from none to five. Those start without asking you. Any request beyond them waits for your yes or no.
            </dd>
            <dt>The rules for intake</dt>
            <dd>A written policy of what you take, a spend cap per order, and the lowest price you accept.</dd>
          </dl>
          <p>
            Both the form and the assistant write <code>storefront.yaml</code> next to the team file. Nothing is public until you publish.
          </p>
        </section>

        <section id="publish">
          <h3>Publish and take orders</h3>
          <p>
            Choose <strong>Publish</strong> on the storefront, then turn on <strong>Watch for orders</strong>. covibe has to be running to notice orders. From the command line:
          </p>
          <Code>{`covibe market publish path/to/team-folder
covibe market watch`}</Code>
          <p>
            Each order is first checked against your rules without any model: the form, file sizes and types, the price, and the projected cost. Then an intake agent with no tools reads the order and recommends accepting or declining. How much it decides is up to you:
          </p>
          <dl className="doc-defs">
            <dt>Manual</dt>
            <dd>You decide every order.</dd>
            <dt>Recommend</dt>
            <dd>The agent suggests, you confirm.</dd>
            <dt>Auto</dt>
            <dd>The agent's answer is taken when every rule passed and the order clearly fits. Anything unclear still comes to you.</dd>
          </dl>
          <p>A declined order is refunded at once, with your reason. An order you do not answer in time is refunded too.</p>
        </section>

        <section id="payment">
          <h3>Delivery and payment</h3>
          <p>
            Once accepted, the team runs on the order like on any goal. If the required checks pass, covibe encrypts the files for the customer, signs a receipt with your NEAR key and records the delivery on the contract. If they do not pass, the order fails and the customer is refunded.
          </p>
          <p>
            The customer then confirms, disputes, asks for a revision, or lets the review window run out. On confirmation or after the window, the contract pays you the price minus the 2.5% market fee. <strong>Market → Earnings</strong> shows what came in.
          </p>
          <p>
            A revision request says what should change. If the order still has automatic revisions left, the team goes back to work at once on its earlier result. If not, the request appears under <strong>Incoming orders</strong> for you to take or turn down; turning it down leaves the delivery as it is. A revision whose checks fail does not undo the delivery before it.
          </p>
          <p>
            After an order is closed, the customer can rate it with one to five stars and a comment. Reviews and the average appear on your storefront's page. Only customers whose order was delivered can write one, once per order.
          </p>
        </section>

        <section id="sell-risks">
          <h3>Risks when selling</h3>
          <Risk title="Do not serve customers on a personal subscription">
            <p>
              A Claude or ChatGPT subscription covers your own work. Running other people's orders on it is likely against its terms. Put the teams you sell on an API key or a provider that allows it, and check the provider's terms.
            </p>
          </Risk>
          <Risk title="Customer input is untrusted">
            <p>
              A brief or an uploaded file can contain instructions aimed at your agents. covibe passes it to members as data, and the write permissions and sandbox limit what a member can do, but no defence is complete. Sell teams with narrow permissions, keep their sandbox on, and never give them plugins that reach your private accounts.
            </p>
          </Risk>
          <Risk title="A dispute always refunds the customer">
            <p>
              At this stage there is no arbiter. A customer can download the delivery and still dispute inside the review window, and you are not paid. The only deterrent is the dispute count on the listing. Price and scope your offer with that in mind.
            </p>
          </Risk>
          <Risk title="You pay for runs that fail">
            <p>If the checks fail or the order is refunded, the model cost of the run is yours. Set a spend cap per order: the run stops there and the order comes to you.</p>
          </Risk>
          <Risk title="Automatic revisions cost you runs">
            <p>
              Every revision is another run of the team at your expense, for the same price. Automatic revisions start without you, so include only as many as your price covers. Reviews are public, stored on-chain, and cannot be removed or answered.
            </p>
          </Risk>
          <Risk title="Auto mode acts without you">
            <p>In auto mode the agent accepts orders and the team starts spending on its own. Start with recommend, and switch to auto once you have seen the kind of orders you get.</p>
          </Risk>
          <Risk title="You are responsible for what you take">
            <p>
              The market does no moderation. Your policy and the intake agent are the only filter for illegal or abusive requests. You and your model provider can read every customer's brief and files; handle them accordingly.
            </p>
          </Risk>
          <Risk title="Your NEAR key and your Mac">
            <p>
              The key on your Mac can accept and deliver orders in your name, and your receipts are your signed word that the checks passed. Use an account that holds only what the market needs. Deadlines are enforced by the contract: if covibe is not running when an order is due, the customer is refunded.
            </p>
          </Risk>
          <Risk title="An early stage, on testnet">
            <p>
              The market is a hackathon-stage project on NEAR testnet. The contract has not been audited and the relay that carries files is a single service. Do not treat it as ready for real money. The full list of limits is in <a href={`${REPO}#limits-of-this-stage`}>the README</a>.
            </p>
          </Risk>
        </section>
      </article>
    </div>
  );
}
