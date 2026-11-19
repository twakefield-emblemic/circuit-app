// Central place for "what show is this and who's using it" — every AI prompt in lib/claude.js
// pulls its event description and scanner framing from here instead of hardcoding one show's
// name/dates/description inline. Swap these (env vars, or just the defaults below) for the next
// show instead of hunting through prompt strings.
//
// Defaults below are set for CES 2027 (this deployment). The previous event this ran for —
// CoCreate LA 2026, an Alibaba.com-hosted B2B sourcing summit — is kept in a comment on each
// var so the shape of what to fill in in the future is obvious.

const EVENT_NAME = process.env.EVENT_NAME || "CES 2027";
const EVENT_DATES = process.env.EVENT_DATES || "Jan 6-9, 2027";
const EVENT_LOCATION = process.env.EVENT_LOCATION || "Las Vegas";
// Was: "an Alibaba.com-hosted B2B sourcing summit connecting buyers with manufacturers and suppliers"
const EVENT_DESCRIPTION =
  process.env.EVENT_DESCRIPTION ||
  "the Consumer Technology Association's big annual consumer-tech trade show, spanning AI, robotics, mobility, and thousands of exhibiting companies";

// One line, inlined mid-sentence into scan/Q&A prompts — keep it short.
const EVENT_BLURB = `${EVENT_NAME} (${EVENT_DATES}, ${EVENT_LOCATION}), ${EVENT_DESCRIPTION}`;

// SCANNER_ROLE describes who's doing the scanning and why, in neutral terms — NOT assumed to be
// "a buyer sourcing products," which was true at CoCreate LA but isn't true at CES. The actual
// intent (customer research, partnership, investor conversation, etc.) comes from each person's
// own stated goals, which the prompts already thread through separately — this just stops the
// prompt itself from putting a thumb on the scale toward "buyer looking to purchase."
const SCANNER_ROLE =
  process.env.SCANNER_ROLE ||
  "someone at the show meeting companies and people worth following up with — could be a potential customer, partner, investor conversation, or something else entirely, depending on their own goals below";

module.exports = { EVENT_NAME, EVENT_DATES, EVENT_LOCATION, EVENT_DESCRIPTION, EVENT_BLURB, SCANNER_ROLE };
