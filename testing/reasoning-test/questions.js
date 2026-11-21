const QUESTION_SET = "reasoning-v1";

const QUESTIONS = [
  {
    id: "tickets",
    title: "Ticket sales",
    description: "A club sold 38 tickets. Each ticket cost either $7 or $11. The club collected $334.",
    prompt: "How many $11 tickets did the club sell?",
    answer: "17 tickets",
    explanation: "Selling every ticket at $7 would bring in $266. The extra $68 comes in $4 increments, so 17 tickets cost $11."
  },
  {
    id: "talks",
    title: "Talk schedule",
    description: "Schedule six talks in slots numbered 1 through 6. Put one talk in each slot and use each name once.",
    rules: [
      "Atlas is immediately before Birch.",
      "Cedar is immediately before Dune.",
      "Ember is immediately before Flint.",
      "Cedar’s slot number is three greater than Atlas’s."
    ],
    prompt: "List the talks in slot order.",
    answer: "No valid schedule",
    explanation: "The three ordered pairs fill the six slots in blocks. The first talks in the blocks must occupy slots 1, 3, and 5. No two of those slots differ by three."
  },
  {
    id: "desks",
    title: "Desk assignment",
    description: "Mira, Omar, Priya, and Ren each occupy one desk. The desks are numbered 1 through 4 from left to right.",
    rules: [
      "Mira sits immediately to the left of Omar.",
      "Priya sits to the right of Ren.",
      "Omar sits at desk 3."
    ],
    prompt: "List the occupants from desk 1 through desk 4.",
    answer: "Ren, Mira, Omar, Priya",
    explanation: "Omar is at desk 3 and Mira is at desk 2. Ren and Priya occupy the remaining desks, with Priya to Ren’s right."
  },
  {
    id: "cabinets",
    title: "The cabinet key",
    description: "Exactly one cabinet contains a key. Exactly one of these labels is true.",
    rules: [
      "Cabinet A reads “The key is in B.”",
      "Cabinet B reads “The key is not in C.”",
      "Cabinet C reads “The key is not in B.”"
    ],
    prompt: "Which cabinet contains the key?",
    answer: "Cabinet C",
    explanation: "The labels on A and C make opposite claims, so exactly one is true. This makes B’s label false, placing the key in C."
  },
  {
    id: "cartons",
    title: "Packing books",
    description: "Pack 116 books into exactly 16 cartons. Each carton must contain 4, 7, or 10 books, and every book must be packed once.",
    prompt: "Give the number of cartons containing 4, 7, and 10 books.",
    answer: "No valid packing",
    explanation: "Four books in each carton would account for 64 books. Each carton can add either zero, three, or six, so the 52 extra books would have to be a multiple of three."
  },
  {
    id: "robot",
    title: "Robot route",
    description: "A robot starts at (0, 0) on a grid and must end at (4, 3) after exactly 10 moves. Each move changes one coordinate by 1 or −1 and leaves the other unchanged. It may revisit a point.",
    prompt: "List the moves in order.",
    answer: "No valid route",
    explanation: "Each move changes the parity of the sum of the coordinates. The robot starts with an even sum and still has an even sum after 10 moves. The destination has a sum of seven."
  },
  {
    id: "jugs",
    title: "Measuring water",
    description: "You have an empty 9-liter jug and an empty 4-liter jug. Neither jug has markings. You may fill a jug from a tap, empty a jug, or pour from one jug into the other until the first is empty or the second is full.",
    prompt: "List a sequence of steps that leaves exactly 6 liters in the 9-liter jug.",
    answer: "Fill the 9-liter jug, pour into the 4-liter jug, then empty the 4-liter jug. Pour from the 9-liter jug into the 4-liter jug again and empty the 4-liter jug. Transfer the remaining liter into the 4-liter jug. Refill the 9-liter jug and pour until the 4-liter jug is full.",
    explanation: "After the first two pours the large jug has 1 liter left. The last pour transfers 3 liters from the refilled large jug, leaving 6 liters."
  },
  {
    id: "handshakes",
    title: "Meeting introductions",
    description: "Ten people attend a meeting. Each pair of people can shake hands once at most.",
    rules: [
      "People A, B, and C each shake hands with exactly two people.",
      "People D, E, F, and G each shake hands with exactly three people.",
      "People H, I, and J each shake hands with exactly five people."
    ],
    prompt: "List a set of pairs that meets every handshake count.",
    answer: "No valid set of handshakes",
    explanation: "The individual counts total 33. Every handshake contributes two to that total, one for each person. The total must therefore be even."
  },
  {
    id: "parcel",
    title: "Parcel delivery",
    description: "A parcel starts at station A and must reach station E. These are the only direct links, and the travel times apply in either direction.",
    table: {
      headers: ["Link", "Minutes"],
      rows: [["A to B", 4], ["A to C", 7], ["B to C", 2], ["B to D", 8], ["C to D", 3], ["C to E", 6], ["D to E", 2]]
    },
    prompt: "Give the fastest route and its total travel time.",
    answer: "A, B, C, D, E in 11 minutes",
    explanation: "The shortest times from A to B, C, and D are 4, 6, and 9 minutes. E is reached in 12 minutes through C or 11 minutes through D."
  }
];
