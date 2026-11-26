export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-App-Password",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const jsonResponse = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    const normalizeType = (t) => {
      if (t === "CAGE" || t === "STOCK_IN") return "CAGE";
      return "FRIDGE TOP-UPS";
    };

    const parseQtyPacks = (qtyText) => {
      const clean = String(qtyText || "").trim().toLowerCase();
      if (clean.includes("x")) {
        const parts = clean.split("x").map((n) => parseFloat(n.trim()));
        if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
          return parts[1];
        }
      }
      const num = parseFloat(clean);
      return isNaN(num) ? 0 : num;
    };

    const sb = async (path, options = {}) => {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
        ...options,
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: options.prefer || "return=representation",
          ...(options.headers || {}),
        },
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (!res.ok) throw new Error(data?.message || JSON.stringify(data));
      return data;
    };

    const pass = request.headers.get("X-App-Password") || "";
    let role = null;
    if (pass && pass === env.ADMIN_PASSWORD) role = "ADMIN";
    else if (pass && pass === env.OPS_PASSWORD) role = "OPS";

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/login" && request.method === "POST") {
        if (!role) return jsonResponse({ error: "Invalid passcode" }, 401);
        return jsonResponse({ ok: true, role });
      }

      if (!role) return jsonResponse({ error: "Unauthorized" }, 401);

      if (path === "/api/state" && request.method === "GET") {
        const drinks = await sb("drinks?order=name.asc");
        const movements = await sb("stock_movements?order=id.desc&limit=1000");
        return jsonResponse({ ok: true, role, drinks, movements });
      }

      if (path === "/api/movements" && request.method === "POST") {
        const body = await request.json();
        const items = Array.isArray(body.items) ? body.items : [body];

        const allDrinks = await sb("drinks");
        const drinkMap = new Map(allDrinks.map((d) => [d.id, { ...d }]));
        const newDrinksToInsert = [];
        const preparedRows = [];
        const stockDeltas = new Map();

        for (const item of items) {
          let drink = null;

          if (item.drink_id === "__NEW__" && item.custom_drink_name) {
            const cleanName = String(item.custom_drink_name).trim().toUpperCase();
            const slug =
              "custom_" +
              cleanName
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "_")
                .replace(/^_|_$/g, "");

            if (drinkMap.has(slug)) {
              drink = drinkMap.get(slug);
            } else {
              drink = {
                id: slug,
                name: cleanName,
                pack_unit: "Carton",
                units_per_pack: 1,
                cage_qty: 0,
                fridge_qty: 0,
                notes: "",
                sort_order: 99,
                is_active: true,
                is_new: true,
              };
              drinkMap.set(slug, drink);
              newDrinksToInsert.push(drink);
            }
          } else if (item.drink_id && drinkMap.has(item.drink_id)) {
            drink = drinkMap.get(item.drink_id);
          }

          if (!drink) continue;

          const qtyPacks = parseQtyPacks(item.qty_text);
          if (qtyPacks <= 0) continue;

          const mType = normalizeType(item.movement_type);

          preparedRows.push({
            entry_date: item.entry_date,
            entry_datetime_label: item.entry_datetime_label || "",
            day_name: item.day_name,
            shift: item.shift || "Auto",
            movement_type: mType,
            drink_id: drink.id,
            drink_name: drink.name,
            pack_unit: "Carton",
            qty_text: String(item.qty_text).trim(),
            qty_packs: qtyPacks,
            officer: item.officer || "Dzul",
            notes: item.notes || "",
          });

          const delta = stockDeltas.get(drink.id) || { cageDelta: 0, fridgeDelta: 0 };
          if (mType === "CAGE") {
            delta.cageDelta += qtyPacks;
          } else if (mType === "FRIDGE TOP-UPS") {
            delta.cageDelta -= qtyPacks;
            delta.fridgeDelta += qtyPacks;
          }
          stockDeltas.set(drink.id, delta);
        }

        if (preparedRows.length === 0) {
          return jsonResponse({ error: "No valid items to update" }, 400);
        }

        if (newDrinksToInsert.length > 0) {
          await sb("drinks", {
            method: "POST",
            prefer: "resolution=merge-duplicates,return=minimal",
            body: JSON.stringify(newDrinksToInsert),
          });
        }

        const inserted = await sb("stock_movements", {
          method: "POST",
          body: JSON.stringify(preparedRows),
        });

        const updatePromises = [];
        for (const [drinkId, delta] of stockDeltas.entries()) {
          const d = drinkMap.get(drinkId);
          if (!d) continue;
          const newCage = Math.max(0, Number(d.cage_qty || 0) + delta.cageDelta);
          const newFridge = Math.max(0, Number(d.fridge_qty || 0) + delta.fridgeDelta);
          updatePromises.push(
            sb(`drinks?id=eq.${encodeURIComponent(drinkId)}`, {
              method: "PATCH",
              prefer: "return=minimal",
              body: JSON.stringify({ cage_qty: newCage, fridge_qty: newFridge }),
            })
          );
        }
        await Promise.all(updatePromises);

        return jsonResponse({ ok: true, inserted });
      }

      // Edit / Update Movement (ADMIN ONLY)
      if (path.startsWith("/api/movements/") && request.method === "PUT") {
        if (role !== "ADMIN") return jsonResponse({ error: "Admin only" }, 403);
        const id = path.split("/").pop();
        const body = await request.json();

        const [oldRow] = await sb(`stock_movements?id=eq.${id}`);
        if (!oldRow) return jsonResponse({ error: "Record not found" }, 404);

        const oldType = normalizeType(oldRow.movement_type);
        const [oldDrink] = await sb(`drinks?id=eq.${encodeURIComponent(oldRow.drink_id)}`);
        if (oldDrink) {
          let c = Number(oldDrink.cage_qty || 0);
          let f = Number(oldDrink.fridge_qty || 0);
          if (oldType === "CAGE") c = Math.max(0, c - Number(oldRow.qty_packs));
          else if (oldType === "FRIDGE TOP-UPS") {
            c += Number(oldRow.qty_packs);
            f = Math.max(0, f - Number(oldRow.qty_packs));
          }
          await sb(`drinks?id=eq.${encodeURIComponent(oldDrink.id)}`, {
            method: "PATCH",
            prefer: "return=minimal",
            body: JSON.stringify({ cage_qty: c, fridge_qty: f }),
          });
        }

        const targetDrinkId = body.drink_id || oldRow.drink_id;
        const [newDrink] = await sb(`drinks?id=eq.${encodeURIComponent(targetDrinkId)}`);
        const newQtyPacks = parseQtyPacks(body.qty_text ?? oldRow.qty_text);
        const newType = normalizeType(body.movement_type ?? oldRow.movement_type);

        if (newDrink) {
          let c = Number(newDrink.cage_qty || 0);
          let f = Number(newDrink.fridge_qty || 0);
          if (newType === "CAGE") c += newQtyPacks;
          else if (newType === "FRIDGE TOP-UPS") {
            c = Math.max(0, c - newQtyPacks);
            f += newQtyPacks;
          }
          await sb(`drinks?id=eq.${encodeURIComponent(newDrink.id)}`, {
            method: "PATCH",
            prefer: "return=minimal",
            body: JSON.stringify({ cage_qty: c, fridge_qty: f }),
          });
        }

        const updatedPayload = {
          entry_date: body.entry_date ?? oldRow.entry_date,
          entry_datetime_label: body.entry_datetime_label ?? oldRow.entry_datetime_label,
          day_name: body.day_name ?? oldRow.day_name,
          shift: body.shift ?? oldRow.shift,
          movement_type: newType,
          drink_id: targetDrinkId,
          drink_name: newDrink ? newDrink.name : oldRow.drink_name,
          pack_unit: "Carton",
          qty_text: String(body.qty_text ?? oldRow.qty_text).trim(),
          qty_packs: newQtyPacks,
          officer: body.officer ?? oldRow.officer,
          notes: body.notes ?? oldRow.notes,
        };

        const [updated] = await sb(`stock_movements?id=eq.${id}`, {
          method: "PATCH",
          body: JSON.stringify(updatedPayload),
        });

        return jsonResponse({ ok: true, updated });
      }

      // Delete Movement (ADMIN ONLY)
      if (path.startsWith("/api/movements/") && request.method === "DELETE") {
        if (role !== "ADMIN") return jsonResponse({ error: "Admin only" }, 403);
        const id = path.split("/").pop();
        const [oldRow] = await sb(`stock_movements?id=eq.${id}`);
        if (!oldRow) return jsonResponse({ error: "Record not found" }, 404);

        const oldType = normalizeType(oldRow.movement_type);
        const [drink] = await sb(`drinks?id=eq.${encodeURIComponent(oldRow.drink_id)}`);
        if (drink) {
          let c = Number(drink.cage_qty || 0);
          let f = Number(drink.fridge_qty || 0);
          if (oldType === "CAGE") c = Math.max(0, c - Number(oldRow.qty_packs));
          else if (oldType === "FRIDGE TOP-UPS") {
            c += Number(oldRow.qty_packs);
            f = Math.max(0, f - Number(oldRow.qty_packs));
          }
          await sb(`drinks?id=eq.${encodeURIComponent(drink.id)}`, {
            method: "PATCH",
            prefer: "return=minimal",
            body: JSON.stringify({ cage_qty: c, fridge_qty: f }),
          });
        }

        await sb(`stock_movements?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" });
        return jsonResponse({ ok: true });
      }

      // Add Master Drink (ADMIN ONLY)
      if (path === "/api/drinks" && request.method === "POST") {
        if (role !== "ADMIN") return jsonResponse({ error: "Admin only" }, 403);
        const body = await request.json();
        const cleanName = String(body.name || "").trim().toUpperCase();
        const slug =
          body.id ||
          cleanName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_|_$/g, "");
        const [drink] = await sb("drinks", {
          method: "POST",
          prefer: "resolution=merge-duplicates,return=representation",
          body: JSON.stringify({
            id: slug,
            name: cleanName,
            pack_unit: "Carton",
            units_per_pack: Number(body.units_per_pack || 1),
            cage_qty: Math.max(0, Number(body.cage_qty || 0)),
            fridge_qty: Math.max(0, Number(body.fridge_qty || 0)),
            notes: body.notes || "",
            sort_order: Number(body.sort_order || 99),
            is_active: body.is_active !== false,
            is_new: false,
          }),
        });
        return jsonResponse({ ok: true, drink });
      }

      // Fine-tune / Edit Drink Balance & Notes (ADMIN ONLY)
      if (path.startsWith("/api/drinks/") && request.method === "PUT") {
        if (role !== "ADMIN") return jsonResponse({ error: "Admin only" }, 403);
        const id = decodeURIComponent(path.split("/").pop());
        const body = await request.json();

        const [existing] = await sb(`drinks?id=eq.${encodeURIComponent(id)}`);
        if (!existing) return jsonResponse({ error: "Drink not found" }, 404);

        const updatedPayload = {
          name: body.name !== undefined ? String(body.name).trim().toUpperCase() : existing.name,
          pack_unit: "Carton",
          units_per_pack:
            body.units_per_pack !== undefined ? Number(body.units_per_pack) : Number(existing.units_per_pack || 1),
          cage_qty:
            body.cage_qty !== undefined ? Math.max(0, Number(body.cage_qty)) : Number(existing.cage_qty || 0),
          fridge_qty:
            body.fridge_qty !== undefined ? Math.max(0, Number(body.fridge_qty)) : Number(existing.fridge_qty || 0),
          notes: body.notes !== undefined ? String(body.notes).trim() : existing.notes,
          is_active: body.is_active !== undefined ? Boolean(body.is_active) : existing.is_active,
        };

        const [updated] = await sb(`drinks?id=eq.${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(updatedPayload),
        });

        return jsonResponse({ ok: true, drink: updated });
      }

      // Full JSON Backup & Restore (ADMIN ONLY)
      if (path === "/api/backup" && request.method === "GET") {
        if (role !== "ADMIN") return jsonResponse({ error: "Admin only" }, 403);
        const drinks = await sb("drinks?order=name.asc");
        const movements = await sb("stock_movements?order=id.asc");
        return jsonResponse({
          exported_at: new Date().toISOString(),
          signature: "dzul art",
          drinks,
          stock_movements: movements,
        });
      }

      if (path === "/api/restore" && request.method === "POST") {
        if (role !== "ADMIN") return jsonResponse({ error: "Admin only" }, 403);
        const backup = await request.json();
        if (!Array.isArray(backup.drinks) || !Array.isArray(backup.stock_movements)) {
          return jsonResponse({ error: "Invalid JSON backup format" }, 400);
        }

        if (backup.drinks.length > 0) {
          await sb("drinks", {
            method: "POST",
            prefer: "resolution=merge-duplicates,return=minimal",
            body: JSON.stringify(backup.drinks),
          });
        }

        await sb("stock_movements?id=gt.0", { method: "DELETE", prefer: "return=minimal" });
        if (backup.stock_movements.length > 0) {
          const cleanMovements = backup.stock_movements.map(({ id, ...rest }) => rest);
          await sb("stock_movements", {
            method: "POST",
            prefer: "return=minimal",
            body: JSON.stringify(cleanMovements),
          });
        }

        return jsonResponse({ ok: true });
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message || "Server error" }, 500);
    }
  },
};