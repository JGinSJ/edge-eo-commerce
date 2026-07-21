# Harper Prerender Cache Component

## Overview

This Harper component provides **static prerendered HTML page caching**.
It stores prerendered, compressed HTML, and exposes simple APIs to manage sitemaps and retrieve prerendered content.

### What it does

- Caches compressed HTML for fast responses
- Supports both **sitemap-driven** and **direct URL** targets
- Offers an **ad-hoc render** endpoint for on-demand rendering
- Orchestrates render job distribution and coordination with external renderer services

## Architecture

The cache component includes an **orchestrator** that manages communication with renderer services:

- **Job Distribution**: Creates and distributes render jobs when URLs are requested or sitemaps are processed
- **Worker Coordination**: Manages renderer service registration and job claiming via HTTP API
- **Real-time Messaging**: Handles error reporting and queue status updates via MQTT pub/sub
- **Content Management**: Processes completed renders and stores compressed HTML in the `PageCache` table
- **Thread Coordination**: Manages multi-threaded operations with inter-thread communication and callbacks

### Renderer Service Integration

The orchestrator communicates with renderer services through:

- **HTTP Endpoints**: `/render_jobs` for job claiming, worker registration, and content upload
- **MQTT Topics**: Real-time error reporting (`render_jobs/failures`) and queue status updates
- **Database Tables**: Job tracking in `render_jobs`, content storage in `PageCache`, scheduling in `PageMeta`

---

## Getting Started

### Running locally

1. `git clone https://github.com/HarperDB/template-static-prerender.git`
2. `cd template-static-prerender`
3. `npm install`
4. `harperdb run .`

This assumes you have the Harper stack already [installed]([Install HarperDB | HarperDB](https://docs.harperdb.io/docs/deployments/install-harperdb)) globally.

### Deployment

Deploy the component using Harper"s **Operations API** via the [Harper CLI](https://docs.harperdb.io/docs/deployments/harper-cli#operations-api-through-the-cli).

---

## Usage

### Endpoints

| Endpoint             | Description                                                       |
| -------------------- | ----------------------------------------------------------------- |
| `/page`              | Fetch cached prerendered HTML and/or trigger ad-hoc prerenders    |
| `/sitemaps`          | Directly manage sitemap sources (add/delete)                      |
| `/render_jobs`       | Directly manage jobs in render pipeline (local to instance)       |
| `/PageCache`         | Directly manage cached prerendered HTML                           |
| `/PageMeta`          | Directly manage individual URLs for caching and refresh schedules |
| `/WorkerAssignments` | Directly manage worker assignments per node                       |
| `/queue_status`      | View queue status (local to instance)                             |

The first two (2) endpoints are the primary means of interacting with this component to manage sitemaps for URL page rendering and accessing the cached prerendered pages. See the sections below for details on interacting with these endpoints.

The `/render_jobs` endpoint is also used by renderer services to claim jobs and upload completed content through the orchestrator.

The last five (5) endpoints provide low level control and direct access to Harper"s REST API. For a full description of what the REST API can do and how to use if your can refer to its [documentation](https://docs.harperdb.io/docs/developers/rest).

This REST interface for the various tables can be used to manually manipulate the data. See the [Data Model](#data-model) below for details on the structure of each table.

---

### Managing sitemaps

The `/sitemaps` endpoint allows you to:

- Set scheduled refreshing of prerendered content for URLs from a sitemap
- Request on-demand rendering of content for URLs from a sitemap

When you add a sitemap url, the component will enqueue jobs for the renderer service to fetch the resources and add the prerendered content to the `PageCache` table. The orchestrator manages job distribution to registered renderer workers and handles completion callbacks to ensure proper content storage.

#### Adding

1. **on-demand**: Directly add URLs from sitemap to the `render_jobs` table to enqueue for prerendering. This is the preferred method for **on-demand** rendering of cached pages. For scheduled updates, use the `POST` method below.

```bash
PUT /sitemap?path=https://www.example.com/sitemap.xml
```

Returns: `204` on success

2. **scheduled**: Add URLs from sitemap to the `PageMeta` table for scheduled prerendering. This is the preferred method for **scheduled / interval** refreshing of cached pages. For on-demand updates, use the `PUT` method above.

Request Body Requirements

- sitemapURL: either the sitemap url or a unique string to identify the urlList (ex: `my_url_list`)
- refreshInterval: time between scheduled updates in milliseconds
- isSitemap: (optional) defaults to true using url provided as a sitemap, set to false if providing a urlList
- urlList: (optional) array of URLs to prerender
- deviceTypes: (optional) array of device types to support for different rendered versions, default is ["desktop", "mobile"]

```bash
POST /sitemap
```

Body:

```JSON
{
"url": "https://www.example.com/sitemap.xml",
"refreshInterval": 86400000,
"deviceTypes": ["desktop", "mobile", "table"]
}

or

{
"url": "my_url_list",
"refreshInterval": 86400000,
"isSitemap": false,
"urlList": ["https://www.example.com", "https://www.example.com/itemPage"],
"deviceTypes": ["desktop"]
}
```

Returns: `204` on success

#### Fetching

Fetches a list of sitemaps that are updated **on-demand**. For sitemaps and URLs updated on a schedule, query against the `PageMeta` table.

```bash
GET /sitemaps/
```

Returns: An array of `sitemap` records

#### Deleting

Delete a sitemap that is updated **on-demand**. For sitemaps and URLs updated on a schedule, query against the `PageMeta` table.

```bash
DELETE /sitemaps?path=https://www.example.com/sitemap.xml
```

Returns: `204`

### Accessing cached prerendered content

The `/page` endpoint allows you to:

- Check cache for prerendered HTML
- If page not cached, triggers ad-hoc prerender and serves new content

It is the primary endpoint for fetching the prerendered content. When a page is not cached, the orchestrator creates a render job and coordinates with renderer services to generate the content.

#### Checking for prerendered content

> **Note**: The `url` query param is required but `deviceType` query param is optional (defaults to dekstop)

```bash
GET /page?deviceType=desktop&url=https://www.example.com
```

Returns: `200` with the content or origin status code for errors / redirects

## Data Model

The cache component uses several Harper tables to manage caching and renderer orchestration operations. Below are the table schemas and their purposes:

#### Sitemap

Stores sitemap sources and their refresh schedules.

| Field             | Type    | Key         | Description                                |
| ----------------- | ------- | ----------- | ------------------------------------------ |
| `url`             | String  | Primary Key | Sitemap URL                                |
| `lastRefresh`     | Date    |             | Timestamp of last sitemap refresh          |
| `refreshInterval` | Long    |             | Interval between refreshes in milliseconds |
| `nextRefresh`     | Date    |             | Scheduled time for next refresh            |
| `isIndex`         | Boolean |             | Whether this is a sitemap index file       |

#### PageMeta

Manages individual page metadata and refresh scheduling.

| Field             | Type   | Key         | Description                                                                     |
| ----------------- | ------ | ----------- | ------------------------------------------------------------------------------- |
| `cacheKey`        | String | Primary Key | Unique key based on url, deviceType, and language                               |
| `url`             | String |             | Full request URL with device suffix (e.g., `https://example.com&device=mobile`) |
| `deviceType`      | String |             | Either desktop, mobile, or tablet                                               |
| `status`          | String | Indexed     | Current page status (`completed`, `scheduled`, `idle`)                          |
| `lastRefresh`     | Long   |             | Timestamp of last page refresh                                                  |
| `refreshInterval` | Long   |             | Refresh interval in milliseconds (-1 for no refresh)                            |
| `nextRefresh`     | Long   | Indexed     | Scheduled timestamp for next refresh                                            |
| `sitemapURL`      | String | Indexed     | Associated sitemap URL                                                          |
| `node`            | String | Indexed     | Processing renderer service node identifier                                     |

#### PageCache

Stores prerendered HTML content and response metadata.

| Field        | Type   | Key         | Description                                       |
| ------------ | ------ | ----------- | ------------------------------------------------- |
| `cacheKey`   | String | Primary Key | Unique key based on url, deviceType, and language |
| `url`        | String |             | Full request URL with device suffix               |
| `statusCode` | Int    |             | HTTP status code from original render             |
| `headers`    | String |             | Serialized HTTP headers from render               |
| `content`    | Blob   |             | Compressed HTML content                           |

#### WorkerAssignments

Contains assignments of worker IDs to nodes for load balancing

| Field       | Type | Key         | Description                                  |
| ----------- | ---- | ----------- | -------------------------------------------- |
| id          | Any  | Primary Key | Any unique identifier                        |
| assignments | Any  |             | Object mapping nodes to arrays of worker IDs |

### Local Database Tables

These tables are local to each Harper component instance and handle job processing:

#### RenderJob (render_job)

Manages render job queue and processing state.

| Field            | Type   | Key         | Description                                              |
| ---------------- | ------ | ----------- | -------------------------------------------------------- |
| `id`             | Any    | Primary Key | Unique job identifier                                    |
| `url`            | String |             | Target URL to render (with device suffix)                |
| `deviceType`     | String |             | Either desktop, mobile, or tablet                        |
| `acceptLanguage` | String |             | Language to be used for page rendering                   |
| `status`         | String | Indexed     | Job status (`pending`, `claimed`, `completed`, `failed`) |
| `attempts`       | Int    |             | Number of processing attempts                            |
| `claimedBy`      | String |             | Worker ID that claimed the job                           |
| `claimedAt`      | Date   |             | Timestamp when job was claimed in epoch milliseconds     |
| `priority`       | Int    | Indexed     | Job priority for queue ordering                          |
| `source`         | String |             | Job source (`sitemap`, `request`, `scheduled`)           |
| `statusCode`     | Int    |             | Status code from origin                                  |
| `headers`        | String |             | Custom headers for rendering                             |
| `createdTime`    | Date   |             | Job creation timestamp in epoch milliseconds             |
| `claimedTime`    | Date   |             | Job claim timestamp in epoch milliseconds                |
| `completedTime`  | Date   | Indexed     | Job completion timestamp in epoch milliseconds           |

#### QueueStatus (queue_status)

Tracks render queue status for orchestrator coordination.

| Field      | Type   | Key         | Description                      |
| ---------- | ------ | ----------- | -------------------------------- |
| `workerId` | Any    | Primary Key | Worker or producer identifier    |
| `status`   | String |             | Queue status (`empty`, `queued`) |

#### RenderWorker (render_worker)

Tracks render queue status for orchestrator coordination.

| Field    | Type   | Key         | Description                                   |
| -------- | ------ | ----------- | --------------------------------------------- |
| `id`     | Any    | Primary Key | Worker identifier                             |
| `status` | String |             | Worker status (`connected` or `disconnected`) |

### Data Flow

1. **Job Creation**: URLs from sitemaps or `/page` requests create entries in `RenderJob`
2. **Job Distribution**: Orchestrator distributes jobs to registered renderer workers via HTTP API
3. **Scheduling**: `PageMeta` tracks refresh intervals and next refresh times
4. **Queue Management**: `QueueStatus` coordinates job distribution across workers
5. **Job Processing**: Renderer services claim jobs and update status through orchestrator
6. **Content Storage**: Orchestrator processes completed renders and stores them in `PageCache` table
7. **Content Serving**: Cache component serves prerendered content via `/page` endpoint requests
