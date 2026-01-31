# British Swim School — Jackrabbit + Telnyx Integration

## The Problem
Parents coming from voice agents or chatbots hit a massive Jackrabbit registration form and have to re-enter everything. Multiple kids × multiple classes = pain.

## The Solution
A proxy server that fetches the Jackrabbit form, injects pre-filled data, and serves it to the parent. They see their info already filled in and just add payment.

## Architecture

```
Voice Agent / Chatbot
  → Collects: name, email, phone, kid names, ages, preferred classes
  → Calls /send-link webhook
  → Parent gets SMS with pre-filled registration link

Parent clicks link:
  → yourdomain.com/register?classId=X&first=Jane&last=Smith&phone=832...
  → Server fetches Jackrabbit form HTML
  → Injects JavaScript to fill fields
  → Parent sees pre-filled form
  → Adds payment info + submits directly to Jackrabbit ✅
```

## Jackrabbit Form Field Map

### Family Info
| URL Param | Jackrabbit Field | Description |
|-----------|-----------------|-------------|
| `last` | FamName | Family last name |
| `address` | Addr | Home address |
| `city` | City | City |
| `state` | State | State (2-letter: TX, CA) |
| `zip` | Zip | Zip code |
| `phone` | HPhone | Primary phone |

### Contact #1 (Parent/Guardian)
| URL Param | Jackrabbit Field | Description |
|-----------|-----------------|-------------|
| `first` | MFName | First name |
| `clast` | MLName | Last name (defaults to family name) |
| `email` | MEmail + ConfirmMEmail | Email (fills both) |
| `cell` | MCPhone | Cell phone (defaults to primary) |
| `contactType` | PG1Type | Father/Mother/Guardian/Parent/Student |

### Contact #2
| URL Param | Jackrabbit Field | Description |
|-----------|-----------------|-------------|
| `c2first` | FFName | First name |
| `c2last` | FLName | Last name |
| `c2email` | FEmail + ConfirmFEmail | Email |
| `c2cell` | FCPhone | Cell phone |
| `c2type` | PG2Type | Father/Mother/Guardian/Parent |

### Students (up to 5: s1-s5)
| URL Param | Jackrabbit Field | Description |
|-----------|-----------------|-------------|
| `s1first` | S1FName | Student 1 first name |
| `s1last` | S1LName | Student 1 last name |
| `s1gender` | S1Gender | Female or Male |
| `s1bdate` | S1BDate | Birth date (MM/DD/YYYY) |
| `s1class` | S1C1 (hidden) | Class ID for student 1 |
| `s1promo` | S1_UField1 | Promo code |
| `s2first` | S2FName | Student 2 first name |
| ... | ... | Same pattern through s5 |

### Other
| URL Param | Jackrabbit Field | Description |
|-----------|-----------------|-------------|
| `source` | FamSource | How did you hear about us |
| `referral` | ReferralName | Referral name |
| `classId` | preLoadClassID | Default class (in Jackrabbit URL) |
| `wl` | WL | 0 = register, 1 = waitlist |
| `org` | ID | Jackrabbit Org ID (default: 545911) |

## Example URLs

### Single kid, one class
```
/register?classId=16887507&first=Jane&last=Smith&phone=8325551234&email=jane@email.com&s1first=Emma&s1last=Smith&s1gender=Female&s1bdate=01/15/2019
```

### Two kids, different classes
```
/register?classId=16887507&first=Jane&last=Smith&phone=8325551234&email=jane@email.com&s1first=Emma&s1last=Smith&s1gender=Female&s1bdate=01/15/2019&s1class=16887507&s2first=Liam&s2last=Smith&s2gender=Male&s2bdate=03/22/2021&s2class=14535963
```

### Multi-franchise (different org IDs)
```
/register?org=545911&classId=16887507&first=Jane&last=Smith&...
/register?org=DIFFERENT_ORG_ID&classId=THEIR_CLASS_ID&first=Jane&last=Smith&...
```

## Setup

```bash
cd jackrabbit-telnyx
npm init -y
npm install express

# Environment variables
export TELNYX_API_KEY="your_key"
export TELNYX_FROM_NUMBER="+18325551234"
export BASE_URL="https://your-deployed-domain.com"

# Run
node server.js
```

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/register?...` | Pre-filled Jackrabbit form proxy |
| POST | `/lookup` | Search classes (voice/chat agent) |
| POST | `/send-link` | Text pre-filled link to caller |
| GET | `/locations` | List all locations |

## Multi-Franchise Support
Each franchise has its own Jackrabbit Org ID. Pass `org=XXXXX` in the URL to target a different franchise. The JSON API and form both accept it:
- `OpeningsJson?OrgID=XXXXX`
- `regv2.asp?id=XXXXX`

## Deploy
Recommended: Railway, Render, or Vercel (with serverless adapter)
