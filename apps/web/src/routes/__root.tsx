import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import stylesheet from "../styles.css?url";
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "dinghy — Your infrastructure, together" },
      { name: "description", content: "Your machines, projects, and deployments. Together in dinghy." },
    ],
    links: [{ rel: "stylesheet", href: stylesheet }],
  }),
  component: () => (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="flex h-full w-full flex-col font-sans">
        <Outlet />
        <Scripts />
      </body>
    </html>
  ),
});
