// Finds colours and typefaces written outside the theme stylesheet, for the theme guard
// (./theme-guard.test.ts). A component may only name the theme's tokens, `var(--…)`, and the
// keywords that carry no colour or typeface of their own.

/** Every CSS named colour, so `border: 1px solid green` is caught as surely as `#008000`. */
const NAMED_COLOURS =
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen canvas canvastext linktext visitedtext activetext buttonface buttontext buttonborder field fieldtext highlight highlighttext selecteditem selecteditemtext mark marktext graytext accentcolor accentcolortext";
const NAMED = new RegExp(`(?<![\\w-])(?:${NAMED_COLOURS.split(" ").join("|")})(?![\\w-])`, "i");
const HEX = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/i;
const COLOUR_FUNCTION = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/i;

/** CSS properties whose value can carry a colour. */
const COLOUR_PROPERTY = /^(?:color|background(?:-color|-image)?|border(?:-[a-z]+)*|outline(?:-color)?|fill|stroke|stop-color|flood-color|lighting-color|box-shadow|text-shadow|text-decoration(?:-color)?|caret-color|accent-color|column-rule(?:-color)?|scrollbar-color|-webkit-tap-highlight-color)$/;
/** The same properties as React's style object names them, and the SVG attributes that take a colour. */
const STYLE_KEY = /\b(color|background(?:Color|Image)?|border(?:[A-Z][a-z]+)*|outline(?:Color)?|fill|stroke|stopColor|boxShadow|textShadow|textDecoration(?:Color)?|caretColor|accentColor)\s*:\s*(["'`])([^"'`]*)\2/g;
const COLOUR_ATTRIBUTE = /\b(fill|stroke|color|stopColor|stop-color|floodColor)=(["'])([^"']*)\2/g;

/** What a value is left with once the theme's tokens and colourless keywords are taken out. */
const residue = (value: string) => value.replace(/var\(--[\w-]+(?:\s*,[^)]*)?\)/g, "").replace(/\b(?:currentcolor|transparent|inherit|initial|unset|revert|none)\b/gi, "");

const colourIn = (value: string) => {
  const rest = residue(value);
  return HEX.test(rest) || COLOUR_FUNCTION.test(rest) || NAMED.test(rest);
};

/** Each colour or typeface written in `source`, as `line N: what`; empty when there is none. */
export function rawStyles(path: string, source: string): string[] {
  const hits: string[] = [];
  const lineOf = (index: number) => source.slice(0, index).split("\n").length;
  if (path.endsWith(".css")) {
    if (/@font-face/i.test(source)) hits.push(`line ${lineOf(source.search(/@font-face/i))}: @font-face`);
    for (const m of source.matchAll(/(?<![\w-])(-?[a-z][a-z-]*)\s*:\s*([^;{}]+)/gi)) {
      const property = m[1]!.toLowerCase();
      const value = m[2]!.trim();
      if ((property === "font-family" || property === "font") && residue(value).replace(/[\d./%\s]|px|rem|em|italic|normal|bold/gi, "") !== "") {
        hits.push(`line ${lineOf(m.index)}: ${property}: ${value}`);
      } else if (COLOUR_PROPERTY.test(property) && colourIn(value)) {
        hits.push(`line ${lineOf(m.index)}: ${property}: ${value}`);
      }
    }
    return hits;
  }
  for (const m of source.matchAll(STYLE_KEY)) if (colourIn(m[3]!)) hits.push(`line ${lineOf(m.index)}: ${m[1]}: ${m[3]}`);
  for (const m of source.matchAll(COLOUR_ATTRIBUTE)) if (colourIn(m[3]!)) hits.push(`line ${lineOf(m.index)}: ${m[1]}="${m[3]}"`);
  for (const m of source.matchAll(/\bfontFamily\s*:\s*(["'`])([^"'`]*)\1/g)) if (residue(m[2]!).trim()) hits.push(`line ${lineOf(m.index)}: fontFamily: ${m[2]}`);
  // A colour written anywhere else in a string, as a hex or a colour function (a named colour word in prose is not one).
  // Comments are left out, and in a component so are single-quoted runs, which there are as often apostrophes in JSX prose.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")).replace(/(?<![:"'`\\])\/\/.*$/gm, (c) => " ".repeat(c.length));
  const strings = path.endsWith(".tsx") ? /(["`])((?:(?!\1)[^\\\n]|\\.)*)\1/g : /(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;
  for (const m of code.matchAll(strings)) {
    const text = m[2]!;
    if (HEX.test(residue(text)) || COLOUR_FUNCTION.test(residue(text))) {
      if (!hits.some((h) => h.startsWith(`line ${lineOf(m.index)}:`))) hits.push(`line ${lineOf(m.index)}: ${text}`);
    }
  }
  return hits;
}
