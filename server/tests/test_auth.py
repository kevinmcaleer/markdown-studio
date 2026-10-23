from __future__ import annotations

from conftest import PASSWORD, Client


def test_fresh_install_invites_the_owner(client):
    data = client.refresh()
    assert data["user"] is None
    assert data["first_user"] is True
    assert data["registration_open"] is True


def test_register_signs_in(client):
    response = client.register(email="kev@example.com")
    assert response.status_code == 200
    assert response.json()["user"]["username"] == "kev"
    assert "password_hash" not in response.json()["user"]
    assert client.refresh()["user"]["username"] == "kev"


def test_post_without_csrf_is_rejected(client):
    response = client.post("/api/auth/login", json={"username": "kev", "password": PASSWORD})
    assert response.status_code == 403


def test_csrf_token_from_another_visitor_is_rejected(app_factory):
    app = app_factory()
    with Client(app) as a, Client(app) as b:
        a.refresh()
        b.refresh()
        b.csrf = a.csrf
        assert b.register().status_code == 403


def test_login_logout(user_client):
    assert user_client.post_json("/api/auth/logout").status_code == 200
    assert user_client.refresh()["user"] is None
    assert user_client.login(password="wrong password!!").status_code == 401
    response = user_client.login()
    assert response.status_code == 200
    assert user_client.refresh()["user"]["username"] == "kev"


def test_remember_me_sets_persistent_cookie(user_client):
    user_client.post_json("/api/auth/logout")
    response = user_client.login(remember=True)
    assert "Max-Age=2592000" in response.headers["set-cookie"]


def test_registration_closed_after_owner(app_factory):
    app = app_factory(ALLOW_REGISTRATION="false")
    with Client(app) as owner:
        assert owner.register().status_code == 200
    with Client(app) as stranger:
        assert stranger.refresh()["registration_open"] is False
        assert stranger.register(username="eve").status_code == 403


def test_change_password_ends_other_sessions(app_factory):
    app = app_factory()
    with Client(app) as laptop, Client(app) as phone:
        laptop.register()
        phone.login()
        response = laptop.post_json(
            "/api/auth/password",
            {"current_password": PASSWORD, "new_password": "a brand new passphrase"},
        )
        assert response.status_code == 200
        assert laptop.refresh()["user"] is not None
        assert phone.refresh()["user"] is None


def test_change_password_needs_current(user_client):
    response = user_client.post_json(
        "/api/auth/password",
        {"current_password": "not my password", "new_password": "a brand new passphrase"},
    )
    assert response.status_code == 400


def test_delete_account(user_client):
    response = user_client.post_json("/api/auth/delete-account", {"confirm_username": "nope"})
    assert response.status_code == 400
    response = user_client.post_json("/api/auth/delete-account", {"confirm_username": "KEV"})
    assert response.status_code == 200
    assert user_client.refresh()["first_user"] is True


def test_login_rate_limited(app_factory):
    with Client(app_factory(LOGIN_RATE_LIMIT=2)) as c:
        c.refresh()
        assert c.login(password="x" * 12).status_code == 401
        assert c.login(password="x" * 12).status_code == 401
        response = c.login(password="x" * 12)
        assert response.status_code == 429
        assert "Retry-After" in response.headers


def test_cookies_are_httponly_and_secure_over_https(app_factory):
    with Client(app_factory(HTTPS="true")) as c:
        response = c.register()
        cookie = response.headers["set-cookie"]
        assert "HttpOnly" in cookie and "Secure" in cookie and "SameSite=lax" in cookie


def test_cookie_domain_for_single_sign_on(app_factory):
    with Client(app_factory(COOKIE_DOMAIN=".kevspowertools.com")) as c:
        response = c.register()
        assert "Domain=.kevspowertools.com" in response.headers["set-cookie"]
