export const PLACES = [
    ['Kimironko', -1.9355, 30.1019], ['Nyabugogo', -1.9393, 30.0445], ['Remera', -1.9578, 30.1127],
    ['Kicukiro', -1.9706, 30.1044], ['Nyamirambo', -1.9833, 30.0417], ['Kacyiru', -1.9364, 30.0908],
    ['Gikondo', -1.9756, 30.0746], ['Kanombe', -1.9686, 30.1395], ['City Centre', -1.9441, 30.0619],
    ['Gisozi', -1.9206, 30.0728], ['Kibagabaga', -1.9261, 30.1149], ['Kagugu', -1.9146, 30.0936],
].map(([name, lat, lng]) => ({ name, lat, lng }));

/** A gently curved mock route. It does not follow real roads. */
export function buildRoute(a, b, rand, points = 14) {
    const bend = (rand() - 0.5) * 0.5;
    const dx = b.lng - a.lng;
    const dy = b.lat - a.lat;
    const route = [];
    for (let i = 0; i <= points; i++) {
        const t = i / points;
        const curve = Math.sin(t * Math.PI) * bend;
        route.push([
            Number((a.lat + dy * t + dx * curve).toFixed(5)),
            Number((a.lng + dx * t - dy * curve).toFixed(5)),
        ]);
    }
    return route;
}

export function routeLengthKm(route) {
    let km = 0;
    for (let i = 1; i < route.length; i++) {
        const dLat = (route[i][0] - route[i - 1][0]) * 111;
        const dLng = (route[i][1] - route[i - 1][1]) * 111 * Math.cos((route[i][0] * Math.PI) / 180);
        km += Math.hypot(dLat, dLng);
    }
    return km;
}
