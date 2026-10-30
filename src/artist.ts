export const firstArtist = (artist: string) => artist.split(",")[0]!.trim();

// What separates the artists in a combined credit, like "A, B", "A & B" or
// "A feat. B".
export const artistSeparator =
  /\s*(?:,|&|\+|\bvs\.?\b|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b)\s*/i;

// Every artist in a credit, in order.
export const creditedArtists = (artist: string) =>
  artist
    .split(artistSeparator)
    .map((name) => name.trim())
    .filter(Boolean);
