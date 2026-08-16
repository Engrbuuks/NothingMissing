# Assets, Inventory and Catalog

Three words that sound similar and mean different things. Getting them straight
is most of learning the system.

## The one-line version

| | What it is | Example |
|---|---|---|
| **Catalog** | The *kinds of things* that exist | "Lenovo IdeaCentre AIO 3, 24-inch, i5, 8GB" |
| **Assets** | The *individual objects* you own | NM-00042, that exact machine, at Ibadan |
| **Inventory** | *Quantities* of interchangeable things | 3,000 litres of diesel |

**The test:** if losing a *specific* one matters, it is an asset. If only the
total matters, it is inventory.

## Why the catalog exists at all

Without it, six identical computers are six rows where somebody typed the
specification six times — as "Lenovo IdeaCentre", "lenovo ideacentre aio",
"Ideacentre 24in", and three more spellings. Nothing can be counted, nothing
compared, and "how reliable is this model" has no answer.

With it, you describe the model **once**. Every unit inherits its
specification, service interval and warranty term. Buying six more next year
needs no configuration at all, and the question "which model fails most" becomes
a query rather than a hunch.

## Describing things: your actual examples

### Different Lenovo All-in-Ones

Both are models under **IT equipment → All-in-one computers → Lenovo**:

| | IdeaCentre AIO 3 24" | ThinkCentre neo 50a 27" |
|---|---|---|
| Processor | Intel i5-1235U | Intel i7-13620H |
| Memory | 8 GB | 16 GB |
| Storage | 512 GB SSD | 1000 GB SSD |
| Screen | 24 in | 27 in |

Each physical machine is an **asset** pointing at one of those models. Twelve
IdeaCentres are twelve assets and one catalog entry.

### Different chairs

Under **Furniture → Seating**:

| | Director high-back | Operator mesh task | Visitor stacking |
|---|---|---|---|
| Type | Executive chair | Task chair | Stacking chair |
| Material | Leather | Mesh | Plastic |
| Height adjustable | Yes | Yes | No |

### Different tables

Same shape — Type (Desk, Workstation, Conference table), Material, and
Width/Depth/Height in millimetres.

## How the description fields work

Fields are defined **per category, once**. A chair is never asked for a
processor; a computer is never asked for upholstery. That is the difference
between a specification that gets filled in and one that does not — a short
form of obviously relevant questions gets answered, and a long generic one gets
skipped.

Set them up at **Catalog → Description fields**. Five kinds:

- **Text** — anything written. A processor name, a colour.
- **Number** — a quantity you might compare or total.
- **Dimension** — a measurement with a unit. Width in mm.
- **Choice** — one of a fixed list. **Prefer this wherever you can**: it is
  what makes answers comparable. A text box asking for material collects
  "leather", "Leather", "genuine leather" and "PU".
- **Yes or no** — height adjustable, lockable.

A starter set is offered based on the categories you already have. Anything in
it can be edited or removed.

## When one unit differs

Reality does not respect the catalog. One IdeaCentre gets its memory upgraded to
16GB; one chair is reupholstered.

Record that **on the asset**, not the model. The asset page has *Record a
difference*, which stores a value for that one unit and marks it clearly:

    Memory   16 GB   [This unit only]   Upgraded March 2026
    Screen   24 in   [Model]

Editing the model instead would silently rewrite the description of every other
unit — which is how a register stops being trustworthy.

## Where things belong

**Asset** if it has a serial number, gets serviced, is assigned to somebody, or
moves between sites and you would notice its absence.

**Inventory** if you count it rather than track it: fuel, filters, safety gear,
stationery, cable.

The awkward middle is cheap furniture. Two hundred identical plastic stacking
chairs are realistically inventory — nobody tracks chair number 147. A
₦450,000 executive chair is an asset. Draw the line where losing one
*specifically* would matter.
