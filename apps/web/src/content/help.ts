/** Help center content, EN and FR. Each article: a summary and sections of paragraphs or
 *  definition lists. Keep it in step with the product: docs/n8n.md, docs/adr and the spec. */

export type Block = { p: string } | { dl: [string, string][] } | { steps: string[] };
export type Section = { h: string; blocks: Block[] };
export type Article = { slug: string; group: string; title: string; summary: string; sections: Section[] };

const en: Article[] = [
  {
    slug: "getting-started",
    group: "Basics",
    title: "Getting started",
    summary: "What Formada does, the weekly rhythm, and who sees what.",
    sections: [
      {
        h: "What Formada does",
        blocks: [
          { p: "Formada reads your company's data warehouse (read-only), models the company as an org web of roles, and every week writes a short list of ranked insight cards for each role: what moved, why it matters to that role, and one action the role is allowed to take." },
          { p: "Numbers are found by code, never by the AI. Detection is deterministic: the code computes each metric, compares it with its own history, and only then asks the AI to explain the signals it found, in the role's language. Any card whose text contains a number that is not in its evidence is rejected before you see it." },
        ],
      },
      {
        h: "The weekly rhythm",
        blocks: [
          {
            steps: [
              "Monday 05:00 (your time zone): the weekly run computes every metric, detects signals, and writes cards for each role.",
              "Monday 08:00: everyone gets a digest email with their new cards and value captured.",
              "During the week: owners act on cards (Action this) or flag them (Not relevant, Impossible).",
              "Every day: daily checks watch a few critical metrics, and initiatives are re-measured when their midpoint or end comes.",
            ],
          },
        ],
      },
      {
        h: "Who sees what",
        blocks: [
          {
            dl: [
              ["You", "The roles you hold, plus every role below them in your department."],
              ["Department head", "The whole department box."],
              ["CEO", "The whole org web."],
              ["Vacant role", "Its cards go to the nearest filled role above it, which can act on them."],
              ["Admin", "Settings: AI model, rule review, usage and workflows."],
            ],
          },
          { p: "Visibility is enforced in the database (row-level security), not in the browser: a card you cannot see is never sent to your screen." },
        ],
      },
    ],
  },
  {
    slug: "dashboard",
    group: "Pages",
    title: "Dashboard",
    summary: "The tiles, panels and tables on the home screen.",
    sections: [
      {
        h: "Tiles",
        blocks: [
          {
            dl: [
              ["Impact at stake", "The sum of the estimated impact of every open card you can see. Each impact comes from the code (the size of the change times the metric's money value), not from the AI."],
              ["Open cards", "Cards waiting for a decision in your scope. The trend shows how many cards were written in each of the last 8 weeks; hover a point to read it."],
              ["Value captured", "Measured change versus baseline on initiatives, converted to money. It is a before-and-after measure, not proof that the action caused the change."],
              ["Initiatives", "Actioned cards being measured. The hint shows how many have finished and the share of cards actioned in the last 90 days."],
            ],
          },
        ],
      },
      {
        h: "Panels",
        blocks: [
          {
            dl: [
              ["Top open cards", "Ranked by estimated impact. Click one to open it on its role."],
              ["Impact by department", "Where the money at stake sits. Hover a bar for the card count."],
              ["Signal types", "Which detection rule raised the open cards (see Cards, signal types)."],
              ["Card quality, 90 days", "Per role: cards shown, still open, actioned, Not relevant, Impossible and expired. These rates are the main quality measure of the product; a high Not relevant share means the role's metrics or thresholds need tuning."],
              ["Recent runs", "The last workflow runs and their status, with LLM tokens used."],
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "org-web",
    group: "Pages",
    title: "Org web",
    summary: "Role nodes, department boxes, vacant roles, routing and roll-ups.",
    sections: [
      {
        h: "Reading the graph",
        blocks: [
          {
            dl: [
              ["Node", "A role (not a person). It shows the holder, the open cards on the role and, when larger, the open cards in its team below."],
              ["Pulsing dot", "The role has open cards."],
              ["Department box", "The roles of one department, with the department's open-card count."],
              ["Dashed node", "A vacant role. It still gets cards; the label shows which role they route to."],
              ["Moving dashes on a line", "Cards rolling up: the team below has open cards that its parent sees in its roll-up."],
              ["Dashed line with an arrow", "A vacant role's cards routing to the role above it."],
              ["Calendar icon", "The role runs daily, not only weekly."],
              ["You", "A role you hold."],
            ],
          },
        ],
      },
      {
        h: "Moving around",
        blocks: [
          {
            steps: [
              "Drag the background to pan.",
              "Use + and − (or Ctrl/⌘ + scroll, or pinch) to zoom; the square button fits the whole web.",
              "Click a node to highlight its chain to the CEO and its team, and to open its profile on the right.",
              "Click the empty background to clear the selection.",
            ],
          },
        ],
      },
      {
        h: "The role profile",
        blocks: [
          { p: "The panel shows the metrics attached to the role (with thresholds and daily checks), the decisions the role owns (the only actions its cards may suggest), the decisions it may not make (hard limits the AI never crosses), and its KPIs. From there, open the role's cards or its history." },
        ],
      },
    ],
  },
  {
    slug: "cards",
    group: "Pages",
    title: "Cards",
    summary: "Anatomy of an insight card: text, impact, evidence, metadata.",
    sections: [
      {
        h: "The text",
        blocks: [
          {
            dl: [
              ["Title", "The entity and the change, at most 80 characters."],
              ["What", "The fact, with numbers taken only from the evidence."],
              ["So what", "Why it matters to this role, in money or units."],
              ["Now what", "One concrete action. The chip below names the role decision it uses."],
            ],
          },
        ],
      },
      {
        h: "Signal types",
        blocks: [
          {
            dl: [
              ["Sustained shift", "The mean of the last 3 weeks is far from the 13 weeks before it (z-score above 2, on the bad side), and most recent weeks agree. One-off spikes do not trigger it."],
              ["Threshold breach", "The latest value is past the threshold set on the role (for example more than 16 weeks of cover, or less than 1 week on a top seller). It fires whatever the trend."],
              ["Week-over-week jump", "A move of 15% or more from last week, confirmed by a level change of at least one standard deviation."],
            ],
          },
          { p: "Signals below 1,000 CAD of estimated impact are dropped, and each role keeps its 8 strongest signals. A role has at most 5 open cards; lower-ranked cards expire after 4 weeks without action." },
        ],
      },
      {
        h: "Impact and confidence",
        blocks: [
          { p: "Estimated impact = size of the change × the metric's money value × the exposure (for example open PO lines, units on hand or weekly sales). It is computed by code and is the same number the ranking uses. Confidence is the AI's judgement of how solid the evidence is; cards are ranked by impact × confidence." },
        ],
      },
      {
        h: "Evidence",
        blocks: [
          { p: "The chart shows the weekly values: the dashed line is the baseline, the dotted line the threshold, and the shaded area the recent weeks being judged. Drivers are the numbers behind the exposure. View SQL shows the exact query that produced the data, so an analyst can check any card." },
        ],
      },
      {
        h: "How this card was made",
        blocks: [
          {
            dl: [
              ["Detected", "When the run that wrote the card ran."],
              ["Data through", "The last data week the card is about."],
              ["Recent / baseline weeks", "How many weeks were judged against how many weeks of history."],
              ["Point z-score", "How unusual the latest single week is."],
              ["Exposure", "The volume the change applies to; frozen into the initiative if you action the card."],
              ["Written by", "The AI provider and model that wrote the wording."],
              ["Fingerprint", "metric : entity : direction. Feedback and duplicate checks use it."],
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "feedback",
    group: "Working with cards",
    title: "Action this, Not relevant, Impossible",
    summary: "What each button does, now and later.",
    sections: [
      {
        h: "The three buttons",
        blocks: [
          {
            dl: [
              ["Action this", "Starts an initiative. The form is prefilled from the card: baseline value and period, measurement window (30 to 120 days), optional target and due date. You can edit before confirming."],
              ["Not relevant", "Closes the card. Its fingerprint is suppressed for your role for 8 weeks. A reason is optional."],
              ["Impossible", "Closes the card. The same action on the same entity is never suggested to your role again. A one-line reason is required."],
            ],
          },
          { p: "Only the role's owner can use the buttons; viewers and people looking at a team member's role see the card read-only." },
        ],
      },
      {
        h: "Rules from feedback",
        blocks: [
          { p: "Feedback changes the data the AI reads, never the workflows, and nothing goes live without a person." },
          {
            dl: [
              ["3 × Not relevant", "On the same metric for one role, a downweight rule is proposed: that metric's signals count half in the ranking."],
              ["1 × Impossible", "A forbid rule is proposed with your reason as its text; it is sent to the AI as a hard limit."],
            ],
          },
          { p: "Proposals appear in Settings › Rule review, where an admin accepts (optionally editing the wording), rejects, or later retires them." },
        ],
      },
    ],
  },
  {
    slug: "ledger",
    group: "Working with cards",
    title: "Initiatives and the value ledger",
    summary: "Baseline, measurements, value captured, keep or stop.",
    sections: [
      {
        h: "How an initiative is measured",
        blocks: [
          {
            steps: [
              "When you action a card, the baseline is the level the card reported (the mean of its recent weeks).",
              "At the midpoint and at the end of the window, the same SQL template measures the same entity again.",
              "Each measurement writes an outcome: the value, the change versus baseline, and the value captured.",
              "At the end the initiative is done and its owner answers one question: keep doing this, or stop.",
            ],
          },
          { p: "Value captured = change versus baseline × the metric's money value × the exposure frozen at action time, signed so that improvement is positive. It is shown as change versus baseline, never as proven causation." },
        ],
      },
      {
        h: "The ledger page",
        blocks: [
          { p: "Totals by department and role, then every initiative with its card, baseline, midpoint and end measurements and window progress. The figure per initiative is the end measurement, or the midpoint while the window is still running." },
        ],
      },
    ],
  },
  {
    slug: "history",
    group: "Working with cards",
    title: "History",
    summary: "Every card and its fate.",
    sections: [
      {
        h: "Using the history",
        blocks: [
          { p: "History lists every card you can see, newest first, with its status, who gave feedback and why, and the initiative it started. Filter by role with the selector and by fate with the chips." },
          {
            dl: [
              ["Open", "Waiting for a decision."],
              ["Actioned", "Became an initiative."],
              ["Not relevant", "Closed and suppressed for 8 weeks."],
              ["Impossible", "Closed; never suggested again to that role."],
              ["Expired", "Pushed out by stronger cards or 4 weeks without action."],
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "workflows",
    group: "Behind the scenes",
    title: "Runs and workflows",
    summary: "WF0 to WF7: what runs when, and what each step does.",
    sections: [
      {
        h: "The workflows",
        blocks: [
          {
            dl: [
              ["WF1 weekly run", "Monday 05:00. Runs every metric back to back (so the warehouse starts once), then for each role: detect signals, build the prompt, write cards with the AI, validate and store them. Ends with WF6."],
              ["WF1a role pipeline", "The per-role part of WF1 and WF2. One role failing does not stop the others."],
              ["WF2 daily check", "Every day at 05:00 except Monday. Runs the daily-check metrics and the metrics of daily-cadence roles; on a threshold breach, or for a daily role, runs the role pipeline for that role."],
              ["WF3 remeasure", "Every day at 06:00. Measures initiatives due a midpoint or end measurement, then refreshes value captured."],
              ["WF4 digest", "Monday 08:00. Emails each person their new cards and value captured."],
              ["WF5 feedback compiler", "After each Not relevant or Impossible, and nightly. Turns repeated feedback into proposed rules."],
              ["WF6 roll-up", "Refreshes each role's open-card counts and value captured, for itself and its team."],
              ["WF7 health", "Hourly. Fails stale runs, checks warehouse credits against the cap, purges old AI logs, tests the warehouse login."],
              ["WF0 error handler", "Marks the runs of a crashed workflow as failed."],
            ],
          },
        ],
      },
      {
        h: "Statuses",
        blocks: [
          {
            dl: [
              ["Succeeded", "Every step worked or had nothing to do."],
              ["Partial", "At least one role step failed after 3 tries; the other roles still got their cards."],
              ["Failed", "The run could not complete (for example the warehouse was unreachable)."],
              ["Running", "In progress. A run with no finish after 6 hours is failed by WF7."],
            ],
          },
          { p: "Every step can be retried safely: each call carries an idempotency key, so a retry never creates duplicate cards. Admins can start a weekly run for the workspace from Settings › Usage › Run now." },
        ],
      },
    ],
  },
  {
    slug: "metrics",
    group: "Behind the scenes",
    title: "Metrics",
    summary: "The metrics in the library and which role watches each.",
    sections: [
      {
        h: "Purchasing",
        blocks: [
          {
            dl: [
              ["Supplier lead time (Buyer)", "Days from order to receipt, per supplier and receipt week. Exposure: open PO lines."],
              ["Supplier fill rate (Buyer)", "Share of ordered units received. Short shipments pull it down. Exposure: open PO lines."],
              ["Freight cost per unit (VP Purchasing)", "Freight per unit ordered, per supplier. Exposure: units ordered in the last 13 weeks."],
              ["Weeks of cover (Planner)", "Stock on hand ÷ recent weekly sales. Above the threshold means overstock."],
              ["Stock cover on top sellers (Planner, daily check)", "The same ratio for the best sellers only. Below the threshold means a stockout is coming."],
            ],
          },
        ],
      },
      {
        h: "Sales and executive",
        blocks: [
          {
            dl: [
              ["Online return rate (Sales ops, daily)", "Rolling 4-week returns as a share of units sold online, per style."],
              ["Wholesale account revenue (Account manager)", "Trailing 28-day revenue per wholesale account, so a missed reorder shows as a drop."],
              ["Discount rate (VP Sales)", "Discounts as a share of gross sales, per store and the web shop."],
              ["Store share of net sales (CEO)", "Each store's share of company net sales per week. A share removes the season that lifts every store at once, so a store losing traffic stands out."],
            ],
          },
          { p: "Each metric has a money value per unit of change (set during onboarding) that turns a change into an estimated impact. SQL templates are versioned and immutable: changing a query creates a new version." },
        ],
      },
    ],
  },
  {
    slug: "settings",
    group: "Admin",
    title: "Settings, people and access",
    summary: "Workspace roles, invites, role assignments, rule review, usage.",
    sections: [
      {
        h: "Who can do what",
        blocks: [
          {
            dl: [
              ["Owner", "Everything an admin can do, plus making or removing owners. A workspace always keeps at least one owner."],
              ["Admin", "Invites people, changes member and admin roles, assigns people to roles in the org web, edits workspace settings and reviews rules."],
              ["Member", "Sees and acts on cards through their roles in the org web. No Settings page."],
              ["Role owner / viewer", "Separate from the workspace role: on each org-web role a person is owner (acts on its cards) or viewer (reads them)."],
            ],
          },
        ],
      },
      {
        h: "Tabs",
        blocks: [
          {
            dl: [
              ["People & invites", "Invite by email with a workspace role, a language and org-web roles. The link works once and expires after 14 days. Change roles, edit assignments, resend or revoke invites, remove people (their history stays)."],
              ["Workspace", "Name, default language, time zone (weekly runs start Monday 05:00 there) and whether admins without a role see card content."],
              ["Rule review", "Accept, edit, reject or retire rules proposed from feedback. The rule drafter may suggest clearer wording."],
              ["Usage", "Warehouse credits this month against the cap, AI tokens and recent runs. Run now starts a weekly run."],
            ],
          },
          { p: "Detection thresholds, weights and the AI model are tuned by the Formada team in their internal console, so every workspace benefits from what they learn. Ask them if a role gets too many or too few cards." },
        ],
      },
    ],
  },
  {
    slug: "glossary",
    group: "Reference",
    title: "Glossary",
    summary: "Terms used across the app.",
    sections: [
      {
        h: "Terms",
        blocks: [
          {
            dl: [
              ["Baseline", "The 13 weeks before the recent window, used as normal."],
              ["Entity", "The thing a signal is about: a supplier, a style, a store, an account."],
              ["Exposure", "The volume a change applies to (lines, units, sales); multiplies impact."],
              ["Fingerprint", "metric : entity : direction; identifies a card for suppression and duplicates."],
              ["Roll-up", "The top cards of the roles below you, shown under From your team. They stay owned by those roles."],
              ["Run", "One execution of a workflow for a workspace: weekly, daily check or remeasure."],
              ["Signal", "A deterministic finding: one entity whose metric moved enough to matter."],
              ["z-score", "How many standard deviations a value is from its baseline."],
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "faq",
    group: "Reference",
    title: "FAQ",
    summary: "Common questions.",
    sections: [
      {
        h: "Questions",
        blocks: [
          {
            dl: [
              ["Why do I have no cards?", "Nothing in your metrics moved enough this week, or the signals were below the materiality floor, or suppressed by your feedback. That is a good week."],
              ["Can the AI invent a number?", "No card with a number outside its evidence (or your role profile) is stored. Rejected drafts are logged for review."],
              ["Why is a card in English and not French?", "Cards are written in the role's language when they are generated. A workspace can temporarily write all cards in one language while it is being set up."],
              ["Who can change what the AI may suggest?", "Only the role profile (decisions owned and forbidden) and accepted rules. Feedback proposes rules; an admin or the Formada team accepts them."],
              ["Can I read a card in the other language?", "Yes: Read in French / Read in English under the card text. A translator agent writes it on demand; it is refused if any number changes."],
              ["Is my data sent to the AI?", "Only aggregates and business entity names (suppliers, styles, stores). No customer names, emails or identifiers."],
            ],
          },
        ],
      },
    ],
  },
];

const fr: Article[] = [
  {
    slug: "getting-started",
    group: "Bases",
    title: "Premiers pas",
    summary: "Ce que fait Formada, le rythme hebdomadaire et qui voit quoi.",
    sections: [
      {
        h: "Ce que fait Formada",
        blocks: [
          { p: "Formada lit l’entrepôt de données de l’entreprise (en lecture seule), modélise l’entreprise comme une toile de rôles et rédige chaque semaine une courte liste de cartes classées pour chaque rôle : ce qui a bougé, pourquoi cela compte pour ce rôle, et une action que ce rôle a le droit de prendre." },
          { p: "Les chiffres sont trouvés par le code, jamais par l’IA. La détection est déterministe : le code calcule chaque indicateur, le compare à son propre historique, puis seulement demande à l’IA d’expliquer les signaux trouvés, dans la langue du rôle. Toute carte contenant un chiffre absent de ses preuves est rejetée avant de vous être montrée." },
        ],
      },
      {
        h: "Le rythme hebdomadaire",
        blocks: [
          {
            steps: [
              "Lundi 5 h (votre fuseau) : l’exécution hebdomadaire calcule chaque indicateur, détecte les signaux et rédige les cartes de chaque rôle.",
              "Lundi 8 h : chacun reçoit un courriel avec ses nouvelles cartes et la valeur captée.",
              "Pendant la semaine : les titulaires agissent (Agir) ou signalent une carte (Non pertinent, Impossible).",
              "Chaque jour : les vérifications quotidiennes surveillent quelques indicateurs critiques et les initiatives sont remesurées à mi-parcours et à la fin.",
            ],
          },
        ],
      },
      {
        h: "Qui voit quoi",
        blocks: [
          {
            dl: [
              ["Vous", "Les rôles que vous occupez, plus tous les rôles sous eux dans votre service."],
              ["Chef de service", "Tout le service."],
              ["PDG", "Toute la toile."],
              ["Rôle vacant", "Ses cartes vont au rôle pourvu le plus proche au-dessus, qui peut agir."],
              ["Administrateur", "Paramètres : modèle d’IA, revue des règles, consommation et flux."],
            ],
          },
          { p: "La visibilité est appliquée dans la base de données (sécurité au niveau des lignes), pas dans le navigateur : une carte que vous ne pouvez pas voir n’est jamais envoyée à votre écran." },
        ],
      },
    ],
  },
  {
    slug: "dashboard",
    group: "Pages",
    title: "Tableau de bord",
    summary: "Les tuiles, panneaux et tableaux de l’accueil.",
    sections: [
      {
        h: "Tuiles",
        blocks: [
          {
            dl: [
              ["Impact en jeu", "La somme de l’impact estimé de chaque carte ouverte visible. Chaque impact vient du code (taille de l’écart × valeur monétaire de l’indicateur), pas de l’IA."],
              ["Cartes ouvertes", "Cartes en attente de décision dans votre périmètre. La tendance montre le nombre de cartes rédigées chacune des 8 dernières semaines ; survolez un point pour le lire."],
              ["Valeur captée", "Écart mesuré par rapport à la base sur les initiatives, converti en argent. C’est une mesure avant-après, pas la preuve que l’action a causé l’écart."],
              ["Initiatives", "Cartes en cours de mesure. L’indice montre combien sont terminées et la part de cartes traitées sur 90 jours."],
            ],
          },
        ],
      },
      {
        h: "Panneaux",
        blocks: [
          {
            dl: [
              ["Principales cartes ouvertes", "Classées par impact estimé. Cliquez pour l’ouvrir sur son rôle."],
              ["Impact par service", "Où se trouve l’argent en jeu. Survolez une barre pour le nombre de cartes."],
              ["Types de signaux", "Quelle règle de détection a levé les cartes ouvertes (voir Cartes, types de signaux)."],
              ["Qualité des cartes, 90 jours", "Par rôle : cartes montrées, ouvertes, traitées, non pertinentes, impossibles et expirées. Une forte part de Non pertinent signifie qu’il faut ajuster les indicateurs ou les seuils du rôle."],
              ["Exécutions récentes", "Les dernières exécutions de flux, leur statut et les jetons d’IA utilisés."],
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "org-web",
    group: "Pages",
    title: "Toile organisationnelle",
    summary: "Nœuds de rôle, services, rôles vacants, acheminement et cumuls.",
    sections: [
      {
        h: "Lire le graphe",
        blocks: [
          {
            dl: [
              ["Nœud", "Un rôle (pas une personne). Il montre le titulaire, les cartes ouvertes du rôle et, si plus élevé, celles de son équipe."],
              ["Point pulsant", "Le rôle a des cartes ouvertes."],
              ["Cadre de service", "Les rôles d’un service, avec son nombre de cartes ouvertes."],
              ["Nœud pointillé", "Un rôle vacant. Il reçoit quand même des cartes ; l’étiquette indique où elles vont."],
              ["Tirets en mouvement", "Cartes qui remontent : l’équipe a des cartes ouvertes que son responsable voit dans son cumul."],
              ["Ligne pointillée fléchée", "Les cartes d’un rôle vacant acheminées vers le rôle au-dessus."],
              ["Icône calendrier", "Le rôle s’exécute chaque jour, pas seulement chaque semaine."],
              ["Vous", "Un rôle que vous occupez."],
            ],
          },
        ],
      },
      {
        h: "Se déplacer",
        blocks: [
          {
            steps: [
              "Glissez le fond pour vous déplacer.",
              "Utilisez + et − (ou Ctrl/⌘ + défilement, ou pincement) pour zoomer ; le bouton carré ajuste toute la toile.",
              "Cliquez sur un nœud pour mettre en évidence sa chaîne jusqu’au PDG et son équipe, et ouvrir son profil à droite.",
              "Cliquez sur le fond pour effacer la sélection.",
            ],
          },
        ],
      },
      {
        h: "Le profil du rôle",
        blocks: [
          { p: "Le panneau montre les indicateurs du rôle (seuils et vérifications quotidiennes), les décisions qu’il possède (les seules actions que ses cartes peuvent suggérer), celles qu’il ne peut pas prendre (limites strictes que l’IA ne franchit jamais) et ses ICP. De là, ouvrez les cartes ou l’historique du rôle." },
        ],
      },
    ],
  },
  {
    slug: "cards",
    group: "Pages",
    title: "Cartes",
    summary: "Anatomie d’une carte : texte, impact, preuves, métadonnées.",
    sections: [
      {
        h: "Le texte",
        blocks: [
          {
            dl: [
              ["Titre", "L’entité et l’écart, 80 caractères au plus."],
              ["Quoi", "Le fait, avec des chiffres tirés uniquement des preuves."],
              ["Et alors", "Pourquoi cela compte pour ce rôle, en argent ou en unités."],
              ["Que faire", "Une action concrète. La pastille indique la décision du rôle utilisée."],
            ],
          },
        ],
      },
      {
        h: "Types de signaux",
        blocks: [
          {
            dl: [
              ["Écart soutenu", "La moyenne des 3 dernières semaines s’éloigne fortement des 13 semaines précédentes (score z supérieur à 2, du mauvais côté) et la plupart des semaines récentes le confirment. Un pic isolé ne le déclenche pas."],
              ["Dépassement de seuil", "La dernière valeur dépasse le seuil fixé sur le rôle (par exemple plus de 16 semaines de couverture, ou moins d’une semaine sur un best-seller). Il se déclenche quelle que soit la tendance."],
              ["Saut d’une semaine à l’autre", "Une variation d’au moins 15 % par rapport à la semaine dernière, confirmée par un changement de niveau d’au moins un écart-type."],
            ],
          },
          { p: "Les signaux de moins de 1 000 $ d’impact estimé sont écartés et chaque rôle garde ses 8 signaux les plus forts. Un rôle a au plus 5 cartes ouvertes ; les moins bien classées expirent après 4 semaines sans action." },
        ],
      },
      {
        h: "Impact et confiance",
        blocks: [
          { p: "Impact estimé = taille de l’écart × valeur monétaire de l’indicateur × exposition (par exemple lignes de BC ouvertes, unités en stock ou ventes hebdomadaires). Il est calculé par le code et sert au classement. La confiance est le jugement de l’IA sur la solidité des preuves ; les cartes sont classées par impact × confiance." },
        ],
      },
      {
        h: "Preuves",
        blocks: [
          { p: "Le graphique montre les valeurs hebdomadaires : la ligne tiretée est la base, la ligne pointillée le seuil, la zone ombrée les semaines récentes jugées. Les facteurs sont les chiffres derrière l’exposition. Voir le SQL montre la requête exacte qui a produit les données, pour que tout analyste puisse vérifier une carte." },
        ],
      },
      {
        h: "Comment cette carte a été produite",
        blocks: [
          {
            dl: [
              ["Détectée", "Quand l’exécution qui l’a rédigée a eu lieu."],
              ["Données jusqu’au", "La dernière semaine de données concernée."],
              ["Semaines récentes / de base", "Combien de semaines ont été jugées par rapport à combien d’historique."],
              ["Score z ponctuel", "À quel point la dernière semaine seule est inhabituelle."],
              ["Exposition", "Le volume auquel l’écart s’applique ; figé dans l’initiative si vous agissez."],
              ["Rédigée par", "Le fournisseur et le modèle d’IA qui ont rédigé le texte."],
              ["Empreinte", "indicateur : entité : sens. Utilisée par la rétroaction et les doublons."],
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "feedback",
    group: "Travailler les cartes",
    title: "Agir, Non pertinent, Impossible",
    summary: "Ce que fait chaque bouton, maintenant et ensuite.",
    sections: [
      {
        h: "Les trois boutons",
        blocks: [
          {
            dl: [
              ["Agir", "Lance une initiative. Le formulaire est prérempli depuis la carte : valeur et période de base, fenêtre de mesure (30 à 120 jours), cible et échéance facultatives. Vous pouvez modifier avant de confirmer."],
              ["Non pertinent", "Ferme la carte. Son empreinte est mise en sourdine pour votre rôle pendant 8 semaines. La raison est facultative."],
              ["Impossible", "Ferme la carte. La même action sur la même entité ne sera plus jamais suggérée à votre rôle. Une raison d’une ligne est requise."],
            ],
          },
          { p: "Seul le titulaire du rôle peut utiliser les boutons ; les autres voient la carte en lecture seule." },
        ],
      },
      {
        h: "Règles issues de la rétroaction",
        blocks: [
          { p: "La rétroaction change les données lues par l’IA, jamais les flux, et rien n’entre en vigueur sans une personne." },
          {
            dl: [
              ["3 × Non pertinent", "Sur le même indicateur pour un rôle : une règle de pondération réduite est proposée (ses signaux comptent pour moitié)."],
              ["1 × Impossible", "Une règle d’interdiction est proposée avec votre raison comme texte ; elle est transmise à l’IA comme limite stricte."],
            ],
          },
          { p: "Les propositions apparaissent dans Paramètres › Revue des règles, où un administrateur les accepte (en modifiant le texte au besoin), les rejette ou les retire plus tard." },
        ],
      },
    ],
  },
  {
    slug: "ledger",
    group: "Travailler les cartes",
    title: "Initiatives et registre de valeur",
    summary: "Base, mesures, valeur captée, continuer ou arrêter.",
    sections: [
      {
        h: "Comment une initiative est mesurée",
        blocks: [
          {
            steps: [
              "Quand vous agissez, la base est le niveau indiqué par la carte (la moyenne de ses semaines récentes).",
              "À mi-parcours et à la fin de la fenêtre, le même gabarit SQL mesure à nouveau la même entité.",
              "Chaque mesure écrit un résultat : la valeur, l’écart par rapport à la base et la valeur captée.",
              "À la fin, l’initiative est terminée et son titulaire répond à une question : continuer ou arrêter.",
            ],
          },
          { p: "Valeur captée = écart par rapport à la base × valeur monétaire de l’indicateur × exposition figée au moment d’agir, signée pour qu’une amélioration soit positive. Elle est présentée comme un écart par rapport à la base, jamais comme une causalité prouvée." },
        ],
      },
      {
        h: "La page Registre",
        blocks: [
          { p: "Totaux par service et par rôle, puis chaque initiative avec sa carte, sa base, ses mesures de mi-parcours et de fin et l’avancement de sa fenêtre. Le montant par initiative est la mesure de fin, ou celle de mi-parcours tant que la fenêtre court." },
        ],
      },
    ],
  },
  {
    slug: "history",
    group: "Travailler les cartes",
    title: "Historique",
    summary: "Chaque carte et son sort.",
    sections: [
      {
        h: "Utiliser l’historique",
        blocks: [
          { p: "L’historique liste toutes les cartes visibles, les plus récentes d’abord, avec leur statut, qui a donné une rétroaction et pourquoi, et l’initiative lancée. Filtrez par rôle avec le sélecteur et par sort avec les pastilles." },
          {
            dl: [
              ["Ouverte", "En attente de décision."],
              ["Traitée", "Devenue une initiative."],
              ["Non pertinente", "Fermée et en sourdine 8 semaines."],
              ["Impossible", "Fermée ; plus jamais suggérée à ce rôle."],
              ["Expirée", "Écartée par des cartes plus fortes ou 4 semaines sans action."],
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "workflows",
    group: "En coulisses",
    title: "Exécutions et flux",
    summary: "WF0 à WF7 : ce qui s’exécute quand, et ce que fait chaque étape.",
    sections: [
      {
        h: "Les flux",
        blocks: [
          {
            dl: [
              ["WF1 hebdomadaire", "Lundi 5 h. Exécute tous les indicateurs à la suite (l’entrepôt ne démarre qu’une fois), puis pour chaque rôle : détecter, préparer l’invite, rédiger avec l’IA, valider et enregistrer. Termine par WF6."],
              ["WF1a pipeline de rôle", "La partie par rôle de WF1 et WF2. L’échec d’un rôle n’arrête pas les autres."],
              ["WF2 vérification quotidienne", "Chaque jour à 5 h sauf le lundi. Exécute les indicateurs à vérification quotidienne et ceux des rôles quotidiens ; sur un dépassement de seuil, ou pour un rôle quotidien, exécute le pipeline du rôle."],
              ["WF3 remesure", "Chaque jour à 6 h. Mesure les initiatives arrivées à mi-parcours ou à la fin, puis met à jour la valeur captée."],
              ["WF4 résumé", "Lundi 8 h. Envoie à chacun ses nouvelles cartes et la valeur captée."],
              ["WF5 compilateur de rétroaction", "Après chaque Non pertinent ou Impossible, et chaque nuit. Transforme la rétroaction répétée en règles proposées."],
              ["WF6 cumul", "Met à jour les cartes ouvertes et la valeur captée de chaque rôle et de son équipe."],
              ["WF7 santé", "Chaque heure. Échoue les exécutions bloquées, compare les crédits d’entrepôt au plafond, purge les anciens journaux d’IA, teste la connexion."],
              ["WF0 gestion d’erreur", "Marque en échec les exécutions d’un flux qui a planté."],
            ],
          },
        ],
      },
      {
        h: "Statuts",
        blocks: [
          {
            dl: [
              ["Réussie", "Chaque étape a fonctionné ou n’avait rien à faire."],
              ["Partielle", "Au moins une étape de rôle a échoué après 3 essais ; les autres rôles ont eu leurs cartes."],
              ["Échouée", "L’exécution n’a pas pu aboutir (par exemple entrepôt injoignable)."],
              ["En cours", "En cours. Sans fin après 6 heures, WF7 la marque en échec."],
            ],
          },
          { p: "Chaque étape peut être relancée sans risque : chaque appel porte une clé d’idempotence, une relance ne crée jamais de doublon. Les administrateurs peuvent lancer une exécution hebdomadaire depuis Paramètres › Consommation › Exécuter maintenant." },
        ],
      },
    ],
  },
  {
    slug: "metrics",
    group: "En coulisses",
    title: "Indicateurs",
    summary: "Les indicateurs de la bibliothèque et le rôle qui suit chacun.",
    sections: [
      {
        h: "Approvisionnement",
        blocks: [
          {
            dl: [
              ["Délai fournisseur (Acheteuse)", "Jours entre commande et réception, par fournisseur et semaine de réception. Exposition : lignes de BC ouvertes."],
              ["Taux de service fournisseur (Acheteuse)", "Part des unités commandées réellement reçues. Les livraisons incomplètes le font baisser."],
              ["Fret par unité (VP Approvisionnement)", "Coût de fret par unité commandée, par fournisseur. Exposition : unités commandées sur 13 semaines."],
              ["Semaines de couverture (Planificateur)", "Stock ÷ ventes hebdomadaires récentes. Au-dessus du seuil : surstock."],
              ["Couverture des best-sellers (Planificateur, quotidien)", "Le même ratio pour les meilleures ventes seulement. Sous le seuil : rupture imminente."],
            ],
          },
        ],
      },
      {
        h: "Ventes et direction",
        blocks: [
          {
            dl: [
              ["Taux de retour en ligne (Opérations des ventes, quotidien)", "Retours sur 4 semaines glissantes en part des unités vendues en ligne, par style."],
              ["Revenu des comptes de gros (Gestionnaire de comptes)", "Revenu sur 28 jours par compte, pour qu’une commande manquée apparaisse comme une baisse."],
              ["Taux de remise (VP Ventes)", "Remises en part des ventes brutes, par magasin et boutique en ligne."],
              ["Part des ventes nettes par magasin (PDG)", "La part de chaque magasin dans les ventes nettes de l’entreprise, par semaine. Une part neutralise la saison qui fait monter tous les magasins, donc un magasin qui perd du trafic ressort."],
            ],
          },
          { p: "Chaque indicateur a une valeur monétaire par unité d’écart (fixée à l’intégration) qui transforme un écart en impact estimé. Les gabarits SQL sont versionnés et immuables : modifier une requête crée une nouvelle version." },
        ],
      },
    ],
  },
  {
    slug: "settings",
    group: "Administration",
    title: "Paramètres, personnes et accès",
    summary: "Rôles de l’espace, invitations, attributions, revue des règles, consommation.",
    sections: [
      {
        h: "Qui peut faire quoi",
        blocks: [
          {
            dl: [
              ["Propriétaire", "Tout ce que fait un administrateur, plus nommer ou retirer des propriétaires. Un espace garde toujours au moins un propriétaire."],
              ["Administrateur", "Invite des personnes, change les rôles membre et administrateur, attribue les rôles de la toile, gère l’espace et revoit les règles."],
              ["Membre", "Voit et traite les cartes de ses rôles dans la toile. Pas de page Paramètres."],
              ["Titulaire / lecteur d’un rôle", "Distinct du rôle dans l’espace : sur chaque rôle de la toile, une personne est titulaire (traite les cartes) ou lecteur (les consulte)."],
            ],
          },
        ],
      },
      {
        h: "Onglets",
        blocks: [
          {
            dl: [
              ["Personnes et invitations", "Invitez par courriel avec un rôle, une langue et des rôles dans la toile. Le lien sert une fois et expire après 14 jours. Modifiez les rôles et attributions, renvoyez ou révoquez une invitation, retirez une personne (son historique est conservé)."],
              ["Espace", "Nom, langue par défaut, fuseau horaire (les exécutions hebdomadaires démarrent le lundi à 5 h) et visibilité des cartes pour les administrateurs sans rôle."],
              ["Revue des règles", "Accepter, modifier, rejeter ou retirer les règles proposées. Le rédacteur de règles peut suggérer une formulation plus claire."],
              ["Consommation", "Crédits d’entrepôt du mois par rapport au plafond, jetons d’IA et exécutions récentes. Exécuter maintenant lance une exécution hebdomadaire."],
            ],
          },
          { p: "Les seuils, pondérations et le modèle d’IA sont réglés par l’équipe Formada dans sa console interne, pour que chaque espace profite de ce qu’elle apprend. Écrivez-lui si un rôle reçoit trop ou trop peu de cartes." },
        ],
      },
    ],
  },
  {
    slug: "glossary",
    group: "Référence",
    title: "Glossaire",
    summary: "Les termes utilisés dans l’application.",
    sections: [
      {
        h: "Termes",
        blocks: [
          {
            dl: [
              ["Base", "Les 13 semaines avant la fenêtre récente, considérées comme normales."],
              ["Entité", "Ce dont parle un signal : un fournisseur, un style, un magasin, un compte."],
              ["Exposition", "Le volume auquel un écart s’applique (lignes, unités, ventes) ; multiplie l’impact."],
              ["Empreinte", "indicateur : entité : sens ; identifie une carte pour la sourdine et les doublons."],
              ["Cumul", "Les meilleures cartes des rôles sous le vôtre, sous De votre équipe. Elles restent à ces rôles."],
              ["Exécution", "Un passage d’un flux pour un espace : hebdomadaire, quotidien ou remesure."],
              ["Signal", "Un constat déterministe : une entité dont l’indicateur a assez bougé pour compter."],
              ["Score z", "Combien d’écarts-types sépare une valeur de sa base."],
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "faq",
    group: "Référence",
    title: "FAQ",
    summary: "Questions fréquentes.",
    sections: [
      {
        h: "Questions",
        blocks: [
          {
            dl: [
              ["Pourquoi n’ai-je aucune carte ?", "Rien dans vos indicateurs n’a assez bougé cette semaine, ou les signaux étaient sous le seuil de matérialité, ou mis en sourdine par votre rétroaction. C’est une bonne semaine."],
              ["L’IA peut-elle inventer un chiffre ?", "Aucune carte contenant un chiffre absent de ses preuves (ou de votre profil) n’est enregistrée. Les brouillons rejetés sont journalisés."],
              ["Pourquoi une carte est-elle en anglais ?", "Les cartes sont rédigées dans la langue du rôle au moment de leur création. Un espace peut temporairement rédiger toutes les cartes dans une seule langue pendant sa mise en place."],
              ["Qui peut changer ce que l’IA suggère ?", "Seuls le profil du rôle (décisions possédées et interdites) et les règles acceptées. La rétroaction propose des règles ; un administrateur ou l’équipe Formada les accepte."],
              ["Puis-je lire une carte dans l’autre langue ?", "Oui : Lire en français / Lire en anglais sous le texte de la carte. Un agent de traduction l’écrit à la demande ; elle est refusée si un chiffre change."],
              ["Mes données sont-elles envoyées à l’IA ?", "Seulement des agrégats et des noms d’entités d’affaires (fournisseurs, styles, magasins). Aucun nom, courriel ou identifiant de client."],
            ],
          },
        ],
      },
    ],
  },
];

export function articles(locale: string): Article[] {
  return locale === "fr" ? fr : en;
}
