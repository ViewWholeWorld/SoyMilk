import assert from "node:assert/strict";
import { test } from "node:test";
import { SITE } from "@aihot/industry/site";
import { isSignInUrl, isSignInRedirect } from "@aihot/backend/content/extract";

const url = (path: string) => new URL(path, SITE.defaultUrl).toString();

test("识别下划线变体、WordPress 和常见扩展名登录路径", () => {
  for (const path of [
    "/users/sign_in", "/users/sign_up", "/log_in", "/wp-login", "/wp-login.php",
    "/member/login.php", "/en/register.html", "/login.asp", "/login.aspx",
    "/login.htm", "/login.jsp", "/login", "/log-in", "/signin", "/sign-in", "/signup", "/sign-up",
  ]) assert.equal(isSignInUrl(url(path)), true, path);
});

test("跳转到登录路径时识别为登录重定向", () => {
  for (const path of ["/users/sign_in", "/wp-login.php?redirect_to=%2Fpost%2F1", "/member/login.php"]) {
    assert.equal(isSignInRedirect(url("/post/1"), url(path)), true, path);
  }
});

test("含登录词的普通文章路径和登录页补尾斜杠不误判", () => {
  for (const path of ["/authorized-retailer", "/authors", "/sso-products", "/login.company", "/auth-for-agents"]) {
    assert.equal(isSignInUrl(url(path)), false, path);
    assert.equal(isSignInRedirect(url("/post/1"), url(path)), false, path);
  }
  assert.equal(isSignInRedirect(url("/users/sign_in"), url("/users/sign_in/")), false);
});
