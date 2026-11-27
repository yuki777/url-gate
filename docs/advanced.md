# Advanced syntax: also block requests from inside pages

The syntax in the [README](../README.md) (protected URLs and exceptions) stops URLs that a person opens as a page. This page covers the cases where that is not enough.

## What a plain line does not stop

A plain line only stops opening that URL in a tab (or an iframe). It does not stop a script in a page that is already open from sending a request to that URL.

That is normally enough. Important actions happen on a page you open, and Touch ID is requested the moment you try to open it. It falls short for URLs where a single API call, with no page opened, hands out something like a token.

## Add `all:`

A line starting with `all:` blocks, in addition to opening the page, every request sent to that URL from inside pages (a script's fetch, image loads, and so on).

```
# For an API that issues tokens, block requests from inside pages too
all:api.example.com/token
```

- Requests to a URL with `all:` can only be sent from a tab that has passed Touch ID. The unlock expires after 2 minutes.
- A tab that opened a protected page with Touch ID can send requests right away. After the unlock expires, requests from a page that is still open are blocked as well.
- An exception (`!`) only applies to opening a page. It does not unblock requests stopped by `all:`.

## Keep the range narrow

`all:` blocks every request from a tab that has not passed Touch ID. So a page that opens without Touch ID (an exception page), or a page still open after the unlock expired, stops working if it uses that URL.

```
all:example.com
!example.com/
```

In this example the top page is an exception and can be opened, but `example.com/style.css` and `example.com/app.js`, which the page loads, are blocked, so it cannot be displayed. With a plain `example.com`, the top page displays normally and Touch ID is requested only when another page is opened.

Write the URLs a person opens as a page as plain lines, and use `all:` on a narrow range such as an API URL.

## The toolbar button

The extension's toolbar button lets you pass Touch ID yourself in situations where the gate does not appear on its own. Pressing it shows the gate page; after Touch ID you return to the same page, and that tab is unlocked for 2 minutes.

Use it when a page that opened without Touch ID (an exception page), or a page still open after the unlock expired, needs to send a request that `all:` blocks. A request from inside a page does not navigate, so no gate appears and the request simply fails. Unlock the tab with the button, then try the action again.

The button only works in a tab showing a page that matches a protected URL or an exception. It does nothing in a tab showing an unrelated site.

## A host named `all`

A leading `all:` is read as the mark for blocking requests too. Only when you need to write a port on a host named `all` (such as an internal server), add a scheme, as in `http://all:8080`.
