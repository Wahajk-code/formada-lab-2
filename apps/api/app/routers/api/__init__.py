"""/api/*: user session, tenant-scoped, visibility enforced by RLS. Used by the web app."""

from fastapi import APIRouter

from app.routers.api import admin, auth, cards, console, onboarding, org, roles, workspace

router = APIRouter(prefix="/api")
router.include_router(auth.router)
router.include_router(org.router)
router.include_router(roles.router)
router.include_router(cards.router)
router.include_router(admin.router)
router.include_router(workspace.router)
router.include_router(onboarding.router)
router.include_router(console.router)
