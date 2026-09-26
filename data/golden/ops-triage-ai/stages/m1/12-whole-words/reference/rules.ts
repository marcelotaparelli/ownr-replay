const RULES = [
  { pattern: /\bdown\b/, category: "INCIDENT", weight: 5 },
  { pattern: /\boutage\b/, category: "INCIDENT", weight: 4 },
  { pattern: /\bbug\b/, category: "BUG", weight: 3 },
  { pattern: /\berror\b/, category: "BUG", weight: 1 },
  { pattern: /\blogin\b/, category: "ACCESS", weight: 4 },
  { pattern: /\bpassword\b/, category: "ACCESS", weight: 2 },
];
