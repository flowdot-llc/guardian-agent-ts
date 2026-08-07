# Contributing to guardian-agent (TypeScript)

Thanks for your interest. Please read the licensing section before opening a pull
request, because this project has a constraint most AGPL projects do not.

## Why contributions need a copyright agreement

This library is released under **AGPL-3.0-or-later**. FlowDot LLC is also the **sole
copyright holder**, which is what makes the dual-licensing described in
[README `## License`](./README.md#license) possible: FlowDot licenses this same code
under proprietary terms for use inside its own commercial products, where it is
compiled directly into shipped binaries.

That arrangement depends entirely on single ownership. If an outside contribution is
merged under AGPL alone, FlowDot is no longer the sole copyright holder. The moment
that code is compiled into a proprietary FlowDot binary, the binary becomes a combined
work under AGPL-3.0 §5, and §13 obliges FlowDot to release the whole product under
AGPL with corresponding source. One merged patch would force that outcome, and it
would not be reversible for anyone who had already received the binary.

This is not a judgement about the contribution. It is arithmetic about copyright.

## What that means in practice

**Before a pull request can be merged, the contributor must agree in writing to assign
copyright in the contribution to FlowDot LLC, or grant FlowDot an irrevocable licence
broad enough to sublicense it under proprietary terms.**

Say so explicitly in the pull request:

> I assign copyright in this contribution to FlowDot LLC, and I confirm the work is
> mine to assign.

Ask before you start on anything substantial, so nobody writes code that cannot be
merged: **licensing@flowdot.ai**.

> The wording above is a plain-language summary of the intent, not reviewed legal text.
> Before accepting the first outside contribution, have a lawyer supply the actual CLA
> or assignment instrument. Do not merge outside work on the strength of this file
> alone.

## If you would rather not assign copyright

That is a legitimate choice and the project still benefits. Options that need no
agreement:

- **Issues** describing bugs, threat models, or spec gaps.
- **Fork it.** AGPL-3.0-or-later gives you that right in full, permanently. Your fork
  is yours; nothing here restricts it.
- **Contribute to [the spec](https://github.com/flowdot-llc/guardian-agent) instead**
  of this reference implementation, where the licensing constraint does not apply the
  same way.

## Development

```bash
npm ci
npm run lint
npm test
npm run build
```

Every change needs test coverage. The audit log is hash-chained and ed25519-signed;
changes touching chain construction, signature verification, or the policy resolution
order (`banned` -> `forever` -> `session` -> `once` -> defaults -> prompt) require a
test proving the invariant still holds. `banned` must beat an allow at every layer.
