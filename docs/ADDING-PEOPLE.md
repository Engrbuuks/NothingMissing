# Letting people sign in

Two kinds of access, and picking the right one matters.

| | Account | Field link |
|---|---|---|
| Who | Anyone who needs the app — managers, admins, auditors | Storekeepers, drivers, site crew |
| Needs | Email and a password of their own | Nothing. A URL in WhatsApp |
| Can | Everything their role allows | Submit counts and faults, which wait for review |
| Costs | Nothing per seat | Nothing |

A storekeeper who counts drums twice a month will never remember a password.
Give them a link. Anybody who needs to approve, review or edit needs an account.

## Inviting somebody

**People → Invite someone to sign in.** Enter their email, pick a role and a
location, create the invitation. You get a link — send it however you like.

The link is shown **once**, because only a hash of it is stored. If you lose
it, press Resend, which issues a fresh one and kills the old.

It expires in 14 days and **only opens for the address you sent it to**. A
forwarded invitation lets nobody else in.

They open the link, create a password, and they are in.

## The roles

| Role | Sees | Notably cannot |
|---|---|---|
| **Owner** | Everything | Nothing — this is the top |
| **Admin** | Everything | Make another owner, close the company |
| **Manager** | Their locations | See purchase costs, change a recorded serial |
| **Requester** | Their locations | Retire an asset, approve anything, see costs |
| **Auditor** | Everything, read only | Change anything at all |

The full table is on the People page, read from the database, so what it says
and what the system does cannot drift apart.

## Several owners — do this early

Only an owner can make another owner. If your single owner leaves or loses
their email, **nobody can administer the company**, and we cannot fix it for
you without going into the database.

People → set a second person to Owner. The page warns while you have only one.

## Changing your own name

**Click your name in the sidebar → your profile.** Change it freely.

It does not rewrite audit rows already written. Those keep the name you held
when you did the thing they describe — otherwise renaming would be a way to
quietly edit history.

## Turning a test company into a real one

Settings → Company profile → change the name. Free to change; it is what prints
on waybills.

**The address cannot change.** `yourslug.nothingmissing.ng` is fixed, because
every field link already shared and every waybill already printed carries it.
If the slug is genuinely wrong, create a fresh company and import your register
into it — that is cleaner than breaking every link in circulation.
