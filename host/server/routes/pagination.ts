// Keyset pagination for the list endpoints.
//
// Rows are read newest first by (key, _id), and a page is the PAGE_SIZE rows
// after a cursor in that order. Unlike skip/offset, a row created or deleted
// while someone pages can't shift the rest of the list under them, and the
// query stays an index seek however deep the page.
//
// The cursor carries the last row's *values*, not just its id, so it still
// works after that row is deleted — or, for a conversation, after a new message
// moves it to the top.

import type { Request, Response } from "express"
import { Types } from "mongoose"

/** The most rows any list endpoint returns at once. */
export const PAGE_SIZE = 20

export interface Page<T> {
  items: T[]
  /** Pass back as `?cursor=` for the next page; null on the last one. */
  nextCursor: string | null
}

const encodeCursor = (at: Date, id: Types.ObjectId): string =>
  Buffer.from(JSON.stringify([at.toISOString(), String(id)])).toString("base64url")

const decodeCursor = (raw: string): { at: Date; id: Types.ObjectId } | null => {
  try {
    const [at, id] = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
    if (typeof at !== "string" || typeof id !== "string") return null
    const date = new Date(at)
    if (Number.isNaN(date.getTime()) || !Types.ObjectId.isValid(id)) return null
    return { at: date, id: new Types.ObjectId(id) }
  } catch {
    return null
  }
}

/** The sort every paginated query uses. `_id` breaks ties between equal keys. */
export const newestFirst = (key: string) => ({ [key]: -1, _id: -1 } as const)

/**
 * The filter selecting rows after `?cursor=`, to merge into the query's own.
 *
 * `{}` on the first page. A malformed cursor is answered with a 400 here and
 * returns null — the caller just returns.
 */
export const afterCursor = (
  req: Request,
  res: Response,
  key: string
): Record<string, unknown> | null => {
  const raw = req.query.cursor
  if (raw === undefined || raw === "") return {}

  const cursor = typeof raw === "string" ? decodeCursor(raw) : null
  if (!cursor) {
    res.status(400).json({ error: "Invalid cursor" })
    return null
  }

  return {
    $or: [
      { [key]: { $lt: cursor.at } },
      { [key]: cursor.at, _id: { $lt: cursor.id } },
    ],
  }
}

/**
 * Trim a query's rows to a page.
 *
 * Queries fetch PAGE_SIZE + 1 rows: the extra one only says whether another
 * page exists, which saves a count and never returns an empty last page.
 */
export const toPage = <T extends { _id: Types.ObjectId }>(
  rows: T[],
  key: (row: T) => Date
): Page<T> => {
  const items = rows.slice(0, PAGE_SIZE)
  const last = items[items.length - 1]
  return {
    items,
    nextCursor: rows.length > PAGE_SIZE && last ? encodeCursor(key(last), last._id) : null,
  }
}
