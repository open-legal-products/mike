/**
 * Synthetic source documents for the citation evaluation. They are shaped
 * like the text the app extracts: PDFs carry `[Page N]` markers, and a
 * spreadsheet is rendered as `## Sheet:` markdown tables with a Row column.
 * Every fact a task asks about sits on a known page or cell, so a citation
 * can be scored against where the fact really is.
 */

export type Fixture = {
  label: string;
  filename: string;
  file_type: "pdf" | "xlsx";
  text: string;
};

const lease = `[Page 1]
COMMERCIAL LEASE AGREEMENT

This Commercial Lease Agreement (the "Lease") is made on 3 March 2025 between Harbourside Properties Limited, a company registered in England and Wales under number 08812345 (the "Landlord"), and Quillon Analytics Ltd, a company registered in England and Wales under number 11904532 (the "Tenant").

1. PREMISES
1.1 The Landlord lets to the Tenant the whole of the third floor of Albion House, 14 Wharf Street, Bristol BS1 4RT, comprising approximately 6,200 square feet of net internal area (the "Premises"), together with the right to use eight car parking spaces in the basement car park.
1.2 The Premises are let together with the rights set out in Schedule 1 and subject to the exceptions and reservations set out in Schedule 2.

2. TERM
2.1 The term of this Lease is ten years starting on 1 April 2025 and ending on 31 March 2035 (the "Term").
2.2 The Tenant may not hold over at the end of the Term without the Landlord's written consent.

[Page 2]
3. RENT
3.1 The initial annual rent is £186,000 (one hundred and eighty-six thousand pounds) exclusive of VAT, payable by equal quarterly instalments in advance on the usual quarter days.
3.2 The first instalment, apportioned from the start of the Term to the next quarter day, is payable on the date of this Lease.
3.3 The Tenant shall have a rent-free period of six months from the start of the Term, during which no annual rent is payable but all other sums remain due.
3.4 If any rent or other sum is unpaid fourteen days after its due date, the Tenant shall pay interest on it at 4% above the Bank of England base rate from the due date until payment.

4. RENT REVIEW
4.1 The annual rent shall be reviewed on 1 April 2030 (the "Review Date") to the higher of the rent payable immediately before the Review Date and the open market rent agreed or determined under this clause.
4.2 If the parties have not agreed the open market rent three months before the Review Date, either party may refer its determination to an independent surveyor acting as an expert.

[Page 3]
5. SERVICE CHARGE AND INSURANCE
5.1 The Tenant shall pay a service charge equal to 18.5% of the costs the Landlord incurs in providing the services listed in Schedule 3, payable quarterly in advance on account.
5.2 The service charge for any service charge year shall not exceed £42,000, increased annually in line with the Consumer Prices Index.
5.3 The Landlord shall insure the Building against the Insured Risks for its full reinstatement value, and the Tenant shall pay a fair proportion of the premium within twenty-one days of demand.

6. REPAIR
6.1 The Tenant shall keep the interior of the Premises in good and substantial repair and condition, but is not liable to put them into any better state of repair than that shown in the Schedule of Condition annexed to this Lease.
6.2 The Landlord shall keep the structure, roof, foundations and common parts of the Building in good repair.

[Page 4]
7. ALTERATIONS
7.1 The Tenant shall not make any structural alterations to the Premises.
7.2 The Tenant may make internal non-structural alterations, including the installation and removal of demountable partitioning, without the Landlord's consent, provided that it notifies the Landlord in writing within ten working days after completion.

8. USE
8.1 The Tenant shall use the Premises only as offices within Class E(g)(i) of the Town and Country Planning (Use Classes) Order 1987.

9. ASSIGNMENT AND UNDERLETTING
9.1 The Tenant shall not assign the whole of this Lease without the Landlord's prior written consent, which shall not be unreasonably withheld or delayed.
9.2 The Tenant shall not assign or underlet part only of the Premises.
9.3 The Landlord may require, as a condition of consent to an assignment, that the Tenant enters into an authorised guarantee agreement in respect of the assignee.

[Page 5]
10. BREAK CLAUSE
10.1 The Tenant may terminate this Lease on 31 March 2030 (the "Break Date") by giving the Landlord not less than nine months' written notice.
10.2 A notice under clause 10.1 shall only be effective if, on the Break Date, the Tenant has paid all the annual rent due under this Lease and gives up vacant possession of the Premises.
10.3 If the Tenant exercises the break, it shall pay the Landlord a break premium equal to six months' annual rent at the rate payable on the Break Date.

11. RENT DEPOSIT
11.1 On the date of this Lease the Tenant shall pay the Landlord a rent deposit of £93,000, to be held in a separate designated account in accordance with the Rent Deposit Deed.

[Page 6]
12. FORFEITURE
12.1 The Landlord may re-enter the Premises and end this Lease if any rent is unpaid twenty-one days after it becomes due, or if the Tenant materially breaches any covenant and fails to remedy that breach within a reasonable period after notice.

13. NOTICES
13.1 Any notice given under this Lease must be in writing and delivered by hand or sent by pre-paid first class post or recorded delivery to the recipient's registered office.
13.2 Notices may not be served by email.

14. GOVERNING LAW
14.1 This Lease and any dispute arising out of or in connection with it are governed by the law of England and Wales, and the courts of England and Wales have exclusive jurisdiction.`;

const nda = `[Page 1]
MUTUAL NON-DISCLOSURE AGREEMENT

This Agreement is dated 12 January 2026 and is made between Quillon Analytics Ltd ("Quillon") and Brightwater Capital LLP ("Brightwater"), each a "Party".

1. PURPOSE
1.1 The Parties wish to exchange Confidential Information for the sole purpose of evaluating a possible investment by Brightwater in Quillon (the "Purpose").

2. CONFIDENTIAL INFORMATION
2.1 "Confidential Information" means all information disclosed by one Party to the other, whether before or after the date of this Agreement, in any form, that is marked as confidential or would reasonably be regarded as confidential.
2.2 Confidential Information does not include information that is or becomes public other than through a breach of this Agreement, or that the recipient already lawfully held free of any obligation of confidence.

[Page 2]
3. OBLIGATIONS
3.1 Each Party shall keep the other's Confidential Information secret and use it only for the Purpose.
3.2 A Party may disclose Confidential Information to its employees, officers and professional advisers who need to know it for the Purpose, provided that they are bound by obligations of confidence no less strict than these.
3.3 A Party may disclose Confidential Information where required by law or by any regulatory authority, giving the other Party as much notice as is lawfully possible.

4. DURATION
4.1 This Agreement continues for two years from its date, and the obligations in clause 3 survive for five years after it ends.

5. RETURN OF INFORMATION
5.1 On written request, each Party shall within ten business days return or destroy the other's Confidential Information, except copies held in routine electronic back-ups.

[Page 3]
6. NON-SOLICITATION
6.1 For twelve months from the date of this Agreement, neither Party shall solicit for employment any employee of the other Party with whom it had contact in connection with the Purpose.

7. REMEDIES
7.1 Each Party acknowledges that damages alone may not be an adequate remedy for breach and that the other Party may seek injunctive relief.

8. GOVERNING LAW
8.1 This Agreement is governed by the law of England and Wales, and disputes shall be referred to the courts of London.`;

const rentSchedule = `## Sheet: Rent schedule

| Row | A | B | C | D |
| --- | --- | --- | --- | --- |
| 1 | Period | Start | Annual rent (£) | Quarterly payment (£) |
| 2 | Rent-free | 01/04/2025 | 0 | 0 |
| 3 | Year 1 (post rent-free) | 01/10/2025 | 186,000 | 46,500 |
| 4 | Years 2-5 | 01/04/2026 | 186,000 | 46,500 |
| 5 | Years 6-10 (pre-review estimate) | 01/04/2030 | 204,600 | 51,150 |

## Sheet: Service charge

| Row | A | B | C |
| --- | --- | --- | --- |
| 1 | Service charge year | Budget (£) | Tenant share (£) |
| 2 | 2025 | 214,000 | 39,590 |
| 3 | 2026 | 221,500 | 40,977.50 |
| 4 | Cap (2026, CPI-adjusted) |  | 43,260 |`;

export const FIXTURES: Fixture[] = [
  { label: "doc-0", filename: "Albion House lease.pdf", file_type: "pdf", text: lease },
  { label: "doc-1", filename: "Brightwater NDA.pdf", file_type: "pdf", text: nda },
  { label: "doc-2", filename: "Rent and service charge.xlsx", file_type: "xlsx", text: rentSchedule },
];

/** Where a fact really is: a page of a PDF, or a sheet cell of a workbook. */
export type ExpectedSource = { doc: string; page?: number; sheet?: string; cell?: string };

export type HistoryMessage = { role: "user" | "assistant"; content: string };

/**
 * Earlier answers as the app replays them. With cite_sources, an answer keeps
 * its [N] markers, and the last answer carries the record of the tools it
 * used. Inline answers are replayed with their tags.
 */
const EARLIER: { question: string; answer: string }[] = [
  {
    question: "What are the rent terms in the Albion House lease?",
    answer:
      "The initial annual rent is £186,000 exclusive of VAT, payable quarterly in advance <<10>>. There is a six-month rent-free period from the start of the term <<12>>. The rent is reviewed upwards only on 1 April 2030 <<15>>, and late payment carries interest at 4% above base rate after fourteen days <<13>>.",
  },
  {
    question: "And how does the break clause work?",
    answer:
      "The tenant can break on 31 March 2030 on at least nine months' written notice <<34>>. The break only works if all rent is paid and vacant possession is given on the break date <<35>>, and the tenant must pay a premium of six months' rent <<36>>.",
  },
  {
    question: "Can Quillon assign or sublet?",
    answer:
      "Quillon can assign the whole lease with the landlord's consent, which cannot be unreasonably withheld <<30>>. It cannot assign or underlet part only <<31>>, and the landlord can ask for an authorised guarantee agreement on an assignment <<32>>.",
  },
];

function earlierTurns(count: number, format: "cite_sources" | "inline"): HistoryMessage[] {
  const turns = EARLIER.slice(0, count);
  return turns.flatMap(({ question, answer }, i) => {
    let ref = 0;
    let content = answer.replace(/<<(\d+)>>/g, (_, id) =>
      format === "inline" ? `[[doc-0 ${id}]]` : `[${++ref}]`,
    );
    if (i === turns.length - 1) {
      content += '\n\n[Tool activity in your previous turn]\n- read_document → doc-0 ("Albion House lease.pdf")';
    }
    return [
      { role: "user" as const, content: question },
      { role: "assistant" as const, content },
    ];
  });
}

export type Task = {
  id: string;
  prompt: string;
  /** Sources a well-cited answer should point at. */
  expected: ExpectedSource[];
  /**
   * Earlier turns, for tasks that test follow-ups, in the shape the app
   * replays them for the given citation format.
   */
  history?: (format: "cite_sources" | "inline") => HistoryMessage[];
  /** Abort the turn once this many answer characters have streamed. */
  stopAfterChars?: number;
  /** Cap output tokens for this task (simulates a length cut-off). */
  maxOutputTokens?: number;
};

export const TASKS: Task[] = [
  {
    id: "single-fact",
    prompt: "How much notice does the tenant need to give to exercise the break in the Albion House lease, and what conditions apply?",
    expected: [{ doc: "doc-0", page: 5 }],
  },
  {
    id: "key-terms",
    prompt: "Summarise the key commercial terms of the Albion House lease for a client: parties, premises, term, rent, rent-free, review, service charge, deposit, break, alienation and repair. Cite each point.",
    expected: [
      { doc: "doc-0", page: 1 },
      { doc: "doc-0", page: 2 },
      { doc: "doc-0", page: 3 },
      { doc: "doc-0", page: 4 },
      { doc: "doc-0", page: 5 },
    ],
  },
  {
    id: "cross-doc",
    prompt: "Quillon is the tenant under the lease and a party to the NDA. Compare the governing law, notice and confidentiality-duration provisions across the two documents, and check whether the spreadsheet's service charge cap is consistent with the lease.",
    expected: [
      { doc: "doc-0", page: 6 },
      { doc: "doc-1", page: 1 },
      { doc: "doc-1", page: 2 },
      { doc: "doc-1", page: 3 },
      { doc: "doc-0", page: 3 },
      { doc: "doc-2", sheet: "Service charge", cell: "C4" },
    ],
  },
  {
    id: "spreadsheet",
    prompt: "From the rent and service charge workbook, what is the quarterly payment in years 2-5 and what is the tenant's 2026 service charge share?",
    expected: [
      { doc: "doc-2", sheet: "Rent schedule", cell: "D4" },
      { doc: "doc-2", sheet: "Service charge", cell: "C3" },
    ],
  },
  {
    id: "long-memo",
    prompt: "In the chat (do not create a document), write detailed advice (around 1,500 words) to Quillon's board on the risks and obligations in the Albion House lease, clause by clause, with citations for every proposition.",
    expected: [
      { doc: "doc-0", page: 2 },
      { doc: "doc-0", page: 3 },
      { doc: "doc-0", page: 4 },
      { doc: "doc-0", page: 5 },
      { doc: "doc-0", page: 6 },
    ],
  },
  {
    // A follow-up: the earlier answer is replayed without its citations.
    id: "follow-up",
    prompt: "Now set out the tenant's repair, alteration and service charge obligations, with citations.",
    expected: [
      { doc: "doc-0", page: 3 },
      { doc: "doc-0", page: 4 },
    ],
    history: (format) => earlierTurns(1, format),
  },
  {
    id: "follow-up-3",
    prompt: "Finally, summarise the forfeiture, notices and governing law provisions, with citations.",
    expected: [{ doc: "doc-0", page: 6 }],
    history: (format) => earlierTurns(3, format),
  },
  {
    // The user presses Stop part-way through a cited answer.
    id: "stopped",
    prompt: "Summarise the key commercial terms of the Albion House lease for a client, with citations for each point.",
    expected: [{ doc: "doc-0", page: 2 }],
    stopAfterChars: 1200,
  },
  {
    // A length cut-off part-way through the answer.
    id: "length-cutoff",
    prompt: "In the chat (do not create a document), write detailed advice (around 1,500 words) to Quillon's board on the risks and obligations in the Albion House lease, clause by clause, with citations for every proposition.",
    expected: [{ doc: "doc-0", page: 2 }],
    maxOutputTokens: 1200,
  },
];
