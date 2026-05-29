const EARTH_RADIUS_KM = 6371;

function toRadians(degrees) {
  return Number(degrees) * Math.PI / 180;
}

function normalizeCoordinate(value, type) {
  if (value === '' || value === undefined || value === null) return Number.NaN;
  const coordinate = Number(value);
  if (!Number.isFinite(coordinate)) return Number.NaN;
  if (type === 'latitude' && (coordinate < -90 || coordinate > 90)) return Number.NaN;
  if (type === 'longitude' && (coordinate < -180 || coordinate > 180)) return Number.NaN;
  return coordinate;
}

function distanceKm(from, to) {
  if (!from || !to) return Number.POSITIVE_INFINITY;
  const lat1 = normalizeCoordinate(from.latitude, 'latitude');
  const lon1 = normalizeCoordinate(from.longitude, 'longitude');
  const lat2 = normalizeCoordinate(to.latitude, 'latitude');
  const lon2 = normalizeCoordinate(to.longitude, 'longitude');
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Number.POSITIVE_INFINITY;

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function sortPickupPoints(points, userLocation, packageType) {
  return (points || [])
    .filter((point) => point.enabled !== false)
    .filter((point) => !packageType || (point.packageTypes || []).includes(packageType))
    .map((point) => {
      const distance = distanceKm(userLocation, point);
      return {
        ...point,
        distanceKm: Number.isFinite(distance) ? Number(distance.toFixed(1)) : null,
        distanceLabel: Number.isFinite(distance) ? `${distance.toFixed(1)}km` : '距离未知'
      };
    })
    .sort((a, b) => {
      if (a.distanceKm === null && b.distanceKm === null) return 0;
      if (a.distanceKm === null) return 1;
      if (b.distanceKm === null) return -1;
      return a.distanceKm - b.distanceKm;
    });
}

module.exports = {
  distanceKm,
  sortPickupPoints
};
